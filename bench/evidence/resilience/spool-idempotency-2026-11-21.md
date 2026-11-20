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
