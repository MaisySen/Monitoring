# Telemetry correctness harness

`node bench/correctness/run.js > report.json` sends a workload with known results through Monitoring's own libraries and agent (Node gateway → Python service with SQLite), then compares what Monitoring reports against that ground truth.

**Ground truth:**
- The plan sets exact counts: 3,000 requests at 55% fast (10 ms), 22% medium (50 ms), 8% slow (200 ms), 5% failing (20 ms, HTTP 500) and 10% chained to Python.
- The client measures every request's latency and reads the trace ID the server returns.
- The harness's own readiness checks are counted too.

| Check | Tolerance |
| --- | --- |
| Hits per service, resource and timeseries | exact |
| Errors and error rate | exact |
| p50/p95/p99 per service (from the APM rollup histograms) and per route (from raw spans) | within 2% (histogram resolution) + 2 ms above the client-measured percentile, never below the injected sleep |
| Log counts per service and status | exact |
| Logs linked to a stored trace | all |
| 60 sampled chained traces: both services, SQLite span, no orphan spans, both logs attached | all |
| Custom counter `truth.requests` by kind | exact sums |

**Latest run** (`bench/evidence/correctness/report-2.json`, run `p2fpk9`): **36/36 checks pass.**

**Bugs this harness found and fixed:**
- **Python logs disappeared.** Monitoring's log handler made the app's `logging.basicConfig(level=..., filename=...)` a silent no-op, so INFO logs were dropped: 0 of 300 arrived. Monitoring now keeps `basicConfig` working.
- **About 30% of custom-metric increments were lost when a process stopped.** Metrics export every 10 s, and neither library flushed on SIGTERM; Node skips `beforeExit` on signals, and Python's default SIGTERM skips `atexit`. Both libraries now flush on SIGTERM/SIGINT, then exit exactly as before. `MONITORING_HANDLE_SIGNALS=false` opts out.
- **Harness bug:** its first version ignored its own readiness checks (3,001 vs 3,000).
