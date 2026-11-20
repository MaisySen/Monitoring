# Monitoring large-scale test

Measured Nov 11, 2026 in one test VM (4 vCPU, 11 GB RAM). Monitoring API, PostgreSQL 18, the Acme Shop demo and its Monitoring Agent all ran on the same machine as the load generator, so these are single-box numbers.

## Workload (`loadgen.js`)

| Dimension | Value |
| --- | --- |
| Hosts | 200 simulated hosts (`scale-host-000`…`199`), each sending 8 host metrics every 15 s |
| Services | 50 services (Node and Python), 8 routes each, Postgres/Redis downstream calls |
| Traces | 400 distributed traces per second, 2–10 spans each: **~2,410 spans/s**, 2% errors |
| Logs | ~408 logs/s, each linked to its trace (failed requests log twice) |
| High-cardinality metric | `scale.orders.placed` tagged with `customer.id` (20,000 values) and `plan`: 2,000 points every 10 s |
| Duration | 10 minutes per run (~1.45 M spans, ~245 k logs, 184 k metric points) |
| Path | OTLP/HTTP straight to Monitoring's intake (protobuf traces, JSON logs and metrics), the way 200 agents would send |

Every record carries `loadtest.run=<run>` so stored counts are checked against sent counts.

## Ingest: no data loss

| Run | Code | Spans sent / stored | Logs sent / stored | Request errors | Intake p50 / p99 |
| --- | --- | --- | --- | --- | --- |
| scale1 | before fixes | — | — | requests timed out (30 s) within the first minute | — |
| scale2 | batched writes | 1,449,090 / **1,449,090** | 244,605 / **244,605** | 0 | 54–75 ms / 107–735 ms |
| scale3 | + rollups (v2) | 1,447,992 / 1,447,992 | 244,535 / 244,535 | 0 | 48–60 ms / 97–388 ms |
| scale4 | final | 1,448,043 / **1,448,043** | 244,613 / **244,613** | 0 | 48–64 ms / 97–193 ms |

APM rollups for scale4 count exactly the 719,440 top-level spans stored.

## Query latency of the UI screens (`query-probe.sh`, last hour)

| Screen / API | Before fixes, end of load | Final, during load | Final, end of load |
| --- | --- | --- | --- |
| APM service list | 5,089 ms | 388 ms | 432 ms |
| APM service page | 1,375 ms | 149 ms | 79 ms |
| Trace search (`service:… status:error`) | 1,551 ms | 762 ms | 366 ms |
| Trace view | 7 ms | 5 ms | 5 ms |
| Log search | 192 ms | 359 ms | 335 ms |
| Log full-text search | 316 ms | 146 ms | 132 ms |
| Log histogram | 162 ms | 249 ms | 258 ms |
| Log facets | 330 ms | 95 ms | 79 ms |
| Metric query (200 hosts, by host) | 39 ms | 76 ms | 85 ms |
| Trace metric query (by service) | 2,193 ms | 1,003 ms | 440 ms |
| Infrastructure host list | 2,613 ms | 252 ms | 86 ms |
| Host map | 2,371 ms | 208 ms | 59 ms |
| High-cardinality metric (63k series, sum by plan) | 679 ms | 1,825 ms | 1,998 ms |
| Dashboards / monitors list | 5 / 6 ms | 6 / 5 ms | 4 / 5 ms |

## Gaps found and fixed

1. **Intake stalled on high-cardinality metrics** (requests timed out). Each new series was created with its own awaited upsert, and `last_seen` was refreshed with one UPDATE per series, each waiting for a WAL flush. Fix: new series are created with one multi-row upsert per request, `last_seen` refreshes are batched into one statement, and Monitoring's connections use asynchronous commit (`MONITORING_SYNCHRONOUS_COMMIT=on` restores the default; a crash can lose the last fraction of a second, never corrupt data).
2. **APM screens scanned every raw span in the range.** Fix: per-minute rollups (`span_stats`) written at intake with a mergeable log-scale latency histogram (~2% relative error, like DDSketch), buffered in memory and flushed every 10 s, with finished minutes compacted to one row per key. Existing installs backfill rollups from stored spans on first start.
3. **Host list scanned the last hour of spans** to list services per host, and all metric series to list integrations. Fix: a small `host_services` table and `hosts.apps`, both maintained at intake.
4. **Trace metrics were keyed by host**, multiplying series by the number of hosts (435k series). Fix: trace metrics are keyed by service/resource/env only.
5. **`status:error` searches could not use an index.** Fix: the search compiles to `error = 1`, backed by a partial index; match counts stop at 10,000 (shown as "10,000+") and facets use the most recent 50,000 matches.
6. **Downstream-services panel joined every span in 15 minutes.** Fix: it samples the service's 2,000 most recent spans.

## Measured limits (documented, not fixed)

- High-cardinality metric queries over ~60,000 series take ~2 s (the engine aggregates series in Node). A SQL push-down was tried and was slower in practice, so it was reverted.
- One PostgreSQL instance on one 4-vCPU box handled ~2,400 spans/s + 400 logs/s with intake p99 under 200 ms; beyond that, plan for a bigger database host, partitioned tables or a columnar store.
- Retention (default 15 days) and disk growth: ~4 GB for the ~6 M spans written during these runs; size Postgres storage for your retention.
