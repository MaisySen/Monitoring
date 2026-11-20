# Spool capacity/fault-injection + intake idempotency (2026-11-21)

Follow-up to direct-spool-2026-11-21.md. Answers: cap accounting, fault injection, oversized
batches, write failures, stale-claim reclaim, and at-least-once honesty at the server.

## Spool unit checks (node, sdks/node/lib/spool.js)

1. Oversized single batch (> cap): written, then self-evicted; directory stays at/under cap; no throw. PASS
2. Write into a read-only directory: no throw; export path continues (in-memory retry still applies). PASS
3. Stale-claim fault injection: a `.claim` file aged 120 s is reclaimed and drained; a fresh claim is left alone. PASS
4. Drain order with a reclaimed claim present: oldest-first by embedded write timestamp (was lexical, which drained the reclaimed file last; fixed). PASS
5. Four Spool instances sharing one directory, 40x100B writes, cap 1000B: total stays <= cap + one max batch. PASS
6. Cap accounting fix: bytes() now counts in-flight `.claim` files (previously excluded, so concurrent
   claimants could exceed the cap envelope while the directory grew). Verified by check 5.

## Intake idempotency (PostgreSQL storage)

Finding: span intake was plain INSERT with no unique constraint - a re-delivered batch (spool drain
after a lost response, exporter retry after a server-side commit) duplicated rows AND re-counted
per-minute rollups (recordSpanStats ran on every accepted batch).

Fix:
- migrate.ts: new migration deletes pre-existing duplicate span rows (keeps earliest) and adds
  `CREATE UNIQUE INDEX spans_uniq ON spans(org_id, trace_id, span_id)`.
- intake/store.ts writeSpans: dedupes the incoming batch against existing rows (chunked SELECT),
  inserts only fresh spans with `ON CONFLICT (org_id, trace_id, span_id) DO NOTHING` as the race
  backstop, and feeds rollups/host-links/trace-metrics only the fresh spans. Pure re-deliveries
  return early. Quota accounting still charges the attempted batch (conservative).

Verification against statnew (4620, PG storage), OTLP/HTTP POST /otlp/v1/traces:
- 5-span batch POSTed twice (both HTTP 200): exactly 5 rows for the trace, span_stats total hits = 5
  (not 10). PASS
- Negative control: a new trace POSTed after inserts normally (1 row). PASS

Not changed (documented in sdks/node/README.md "Delivery guarantees"):
- Logs have no producer-assigned natural key: re-delivery after a lost response can duplicate log
  rows (at-least-once).
- Metrics are not spooled; after the in-memory retry window they are dropped.
- ClickHouse storage path remains plain insert (no dedupe); the MV-derived rollups inherit that.
- Delivery claim stays at-least-once, never exactly-once: the disk-full window (cap reached +
  destination down) still drops oldest data by design, and duplicate-free observed runs are not
  promoted to exactly-once.

## Round 2 (same day, after review): real failure/concurrency windows

Review correctly flagged that round 1 was narrower than claimed. Round 2:

Spool (real processes, real failure injection):
- A. Four INDEPENDENT node processes (fork), 10x100B each, cap 1000B: directory total = 1000B. PASS
- B. Slow-send window: send lasting 3x staleMs (1200ms vs 400ms) was NOT reclaimed by a rival
  drainer polling every 120ms. Found and fixed first: the claim mtime was set at claim time and
  never refreshed, so any send > staleMs WAS reclaimable (duplicate delivery). Fix: heartbeat
  refreshes claim mtime every staleMs/3 during send; a live claim is never stale. PASS after fix.
- C. Claimant SIGKILLed mid-send (send promise never resolves): heartbeat stops, rival reclaims
  after staleMs and delivers the payload exactly once, no leftovers. PASS
- D. ENOSPC-class failure: ulimit -f 1 forces EFBIG on write: write() does not throw. PASS
  (read-only-dir from round 1 remains as the EACCES case; true /dev-full ENOSPC not simulated:
  no mount privileges in this sandbox - the fs error path is the same catch).

Intake idempotency (PostgreSQL):
- E. Racing identical intake: 4 PARALLEL identical 5-span POSTs. Round-1 code (dedupe SELECT +
  ON CONFLICT) gave 5 rows but span_stats hits = 10: every racer passed its SELECT and fed the
  rollups. Fix: ON CONFLICT ... DO NOTHING RETURNING trace_id, span_id; rollups/host-links/trace
  metrics are fed ONLY the rows this request actually inserted; all insert chunks run in one
  transaction so a mid-batch failure rolls back every row. Re-verified: 4 parallel POSTs -> 5 rows,
  5 hits. Sequential double-POST -> 5 rows, 5 hits. New-trace negative control inserts. PASS
- F. Migration on populated duplicate data (scratch table, old shape, 3+1+1 dupes incl. cross-org
  same trace/span ids): dedupe collapses to one row per (org_id, trace_id, span_id), unique index
  created, ON CONFLICT reinsert is a no-op, cross-org rows preserved (org_id in the key). PASS
- G. Cross-org separation: structural - spans_uniq keys on org_id; verified in F that identical
  (trace_id, span_id) under different orgs both survive.

Known remaining gap (disclosed, not claimed safe): span-row insert and span_stats rollup are NOT in
one transaction (recordSpanStats uses its own pool queries). A server crash between insert-commit
and rollup leaves rows whose rollup contribution is lost, and the retry then looks like a pure
re-delivery. Rows stay correct (no duplicates); per-minute rollups can undercount by one batch in
that crash window. Fix (transactional rollup) queued.

ClickHouse path and logs/metrics differences preserved and documented as before.
