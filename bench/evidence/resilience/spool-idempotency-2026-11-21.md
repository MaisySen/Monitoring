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

## Round 3: outage e2e against idempotent intake + transactional rollups (build 09697a7)

server_outage_long (45 s outage, 100 spans/s x 110 s, spool ON, direct app->server):

| run | retry window | spans | span dupes | logs | log dupes |
| --- | --- | --- | --- | --- | --- |
| e2e3 | 30 s (default) | 11,000/11,000 | 0 | 5,449/5,500 | 0 |
| e2e4 (diag) | 30 s (default) | 11,000/11,000 | 0 | 5,448/5,500 | 0 |
| e2e5 (control) | 60 s (> outage) | 11,000/11,000 | 0 | 5,500/5,500 | 0 |

- Spans: zero loss AND zero duplicates through a real 45 s outage with spool drain: rows == unique.
  The idempotent intake holds end-to-end, including the drain-after-restart path.
- Logs, residual window: exactly the records emitted in the kill-boundary second (seq 1930-2032 in
  e2e4, contiguous, ~1 s, 0.9%) never arrive when the outage (45 s) outlasts the retry window (30 s).
  Loss is record-granular, not batch-granular, which rules out a whole-batch spool miss; the diag
  log shows the OTel BatchLogRecordProcessor's exportTimeoutMillis (30 s, same value as our retry
  window) firing "Timeout" once. Control run with the retry window longer than the outage loses
  nothing, so the defect sits in the retry-deadline -> spool / processor-timeout interaction at the
  kill boundary, not in the spool itself, not server-side. Root cause not yet isolated (queued).
  Mitigation today: set MONITORING_EXPORT_RETRY_SECONDS above the longest outage to absorb; spans
  are unaffected either way.
- Harness change: server-only.js gains GEN_DEBUG_DIAG/GEN_ERR_FILE capture (preload diag-setup.js,
  full gen stderr to a file) - used for the e2e4/e2e5 evidence above.
- First rerun attempt failed with 403 on every intake: the resilience DB's API key had been deleted
  by an earlier key-lifecycle test. Minted a fresh key (api_keys row, name 'e2e-rerun') and reran.
  Disclosed as a process failure of the first attempt, not a product defect.

## Round 4: kill-second log "loss" root-caused and fixed (drained-resource serialization)

The 51/52/50-record "loss" was not loss: the drained batch WAS stored - under service='' and
host=''. Chain, each step measured:

1. The batch in flight at the kill spools correctly after the retry deadline (DIAG_LOGS trace).
2. Drain after recovery sends it; the server returns 200 and COMMITS the rows (otlpToLogs decoded
   n=5 in a minimal repro: writer on a dead port, drainer on the live server).
3. The rows were invisible to the bench because the drained records carried EMPTY resource
   attributes: JSON.stringify of a live LogRecord stores resource as
   {_rawAttributes, _asyncAttributesPending, _memoizedAttributes} (ResourceImpl internals), and the
   first slimRecord only read resource.attributes -> {} -> server stored service='', host=''.
4. First fix attempt (read _rawAttributes pairs) resurrected service.name="unknown_service:node":
   _rawAttributes is PRE-merge and contains THREE service.name entries ending with the
   defaultResource() value; the Resource getter resolves merges with first-wins precedence
   (_memoizedAttributes shows the resolved value).
5. Final fix: slimRecord's resourceAttributes() prefers _memoizedAttributes (resolved), falls back
   to _rawAttributes with FIRST-occurrence-wins, then plain attributes/_attributes shapes.

Verification:
- Minimal repro after fix: drained log lands with service='mini-drain', host='modal' (was '', '').
- Full outage e2e rerun (server_outage_long, 45 s outage, 100 spans/s x 110 s, spool ON,
  retry 30 s default): spans 11,000/11,000 with 0 duplicates, logs 5,500/5,500 with 0 duplicates.
  The one empty-service row in the DB window is a pre-fix leftover (seq 94000, ts before the fix).
- The earlier "60 s retry window control" result is superseded as an explanation: with the
  serialization fixed, the default 30 s window also delivers everything; the control was masking a
  drain-serialization defect, not bounding a retry-window interaction.

Server-side DIAG_OTLP=1 env gate added to the OTLP logs route (logs decoded count); kept as a
temporary diagnostic alongside DIAG_LOGS.

## Round 5: interruption fault injection for the transactional rollup (build 07f66f3)

The dedupe POST-pair checks did not themselves prove the crash-window claim; these do:

A. Precommit kill: 3,000-span batch POSTed to resil; server SIGKILLed ~120 ms into processing
   (client saw 000). After restart: 0 rows, 0 span_stats hits for the batch - the multi-chunk
   insert rolls back completely (all chunks are one transaction). Retry: 200, 3,000 rows /
   3,000 hits. A second identical POST: still 3,000 / 3,000. PASS

B. Postcommit lost response: same-shape 400-span batch sent through a proxy that forwards to the
   server and DESTROYS the client socket when the upstream response arrives (curl exit 52, empty
   reply - server committed, client believes it failed). Direct retry: 200. Final: 400 rows /
   400 hits - the re-delivery was dropped by the RETURNING-based dedupe and rollups were not
   re-counted. PASS

Still outside the transaction (separately scoped, disclosed): recordHostServices (host->service
links; upsert-shaped, re-derived on any later span from that host) and the derived trace.* metric
points (append-only metric intake). A postcommit crash before those side effects runs loses them
for that batch and the re-delivery skips them (rows exist). Span rows + span_stats - the data the
APM screens read - are transactional; host links self-heal on the next span; trace.* points can
undercount by one batch in that window. Not claimed safe.
