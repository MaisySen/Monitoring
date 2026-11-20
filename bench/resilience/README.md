# Resilience tests: failure recovery and alert reliability

## Failure recovery (`recovery.js`)

Numbered telemetry flows through the real pipeline while one part breaks:

**Pipeline:** app (`@monitoring/trace` / `monitoring-trace`) → Monitoring Agent → Monitoring server → Postgres.

**Load:** 200 spans/s with `seq=N`, plus one log line per second span; the long outage runs at 600 spans/s.

**Counting:** Monitoring's database is checked for unique and duplicate sequence numbers. Recovery time is when the first span created after the fault cleared becomes visible.

```
node bench/resilience/recovery.js > results.json                 # Node generator (gen.js)
GEN_LANG=python node bench/resilience/recovery.js > results.json # Python generator (gen.py)
SCENARIOS=agent_restart,db_restart node bench/resilience/recovery.js
```

### Results (Nov 12, 2026, one test VM)

| Scenario | Fault | Lang | Spans sent | Lost | Duplicates | Logs sent | Lost | Duplicates | Fresh data after recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | none | Node | 18,000 | 0 | 0 | 9,000 | 0 | 0 | 0.6 s |
| Baseline | none | Python | 18,000 | 0 | 0 | 9,000 | 0 | 0 | 0.6 s |
| Backend outage | Monitoring server down 60 s | Node | 18,000 | **0** | 0 | 9,000 | **0** | 0 | 0.8 s |
| Backend outage | Monitoring server down 60 s | Python | 18,000 | **0** | 0 | 9,000 | **0** | 0 | 1.2 s |
| Database restart | Postgres fast restart (2.6 s) | Node | 18,000 | **0** | 0 | 9,000 | **0** | 0 | 3.6 s |
| Long outage / full queue | server down 240 s at 600 spans/s | Node | 180,000 | **0** | 0 | 90,000 | **0** | 0 | 0.4 s |
| Agent restart, **before fix** | agent SIGTERM + start | Node | 18,000 | **201** | 0 | 9,000 | 0 | 0 | 1.3 s |
| Agent restart, after fix | agent SIGTERM, back in about 1.1 s | Node (run 1) | 18,000 | **0** | 0 | 9,000 | **0** | 0 | 0.6 s |
| Agent restart, after fix | agent SIGTERM, back in about 1.1 s | Node (run 2) | 18,000 | **0** | 0 | 9,000 | **0** | 0 | 0.6 s |
| Agent restart, after fix | agent SIGTERM, back in about 1.1 s | Python | 18,000 | **0** | 0 | 9,000 | **0** | 1 | 0.6 s |
| Agent absent about 30 s | no agent until the test started one | Node | 18,000 | 104 | 0 | 9,000 | 1,125 | 0 | 0.6 s |

**What protects the data:**
- **Agent → server:** the agent's exporter uses a **disk-backed queue** (`file_storage`, 1,000 requests) with unlimited retry (1 s → 30 s backoff). A 4-minute server outage at 600 spans/s queued and drained completely; 180,000 spans and 90,000 logs arrived exactly once. A Postgres restart surfaces as 5xx responses from intake, which the agent retries.
- **App → agent, fixed here:** Monitoring's span exporters (Node `lib/span-exporter.js`, Python `monitoring/_span_exporter.py`) dropped a batch whenever the agent was unreachable. That's 201 spans per restart, whatever was in flight. They now retry network errors and 408/429/502/503/504 with exponential backoff (250 ms → 5 s, honoring Retry-After) for up to `MONITORING_EXPORT_RETRY_SECONDS` (default 30). Spans keep queueing in the batch processor meanwhile (16,384). A real agent restart now loses nothing.
- **Shutdown:** both libraries now flush on SIGTERM/SIGINT (see `bench/correctness`).

**Measured limits:**
- **App-side buffering is bounded.** If the agent is gone for longer than the 30 s retry budget, the oldest batches are dropped in the app. The "agent absent about 30 s" row lost 104 spans; the stock OpenTelemetry log exporter, which retries less, lost 1,125 logs. Run the agent under a supervisor (systemd `Restart=always` or a Docker restart policy). Raise `MONITORING_EXPORT_RETRY_SECONDS` for longer gaps.
- **The agent's disk queue holds 1,000 export requests.** Each request is a batch of up to a few thousand items, so about 240 s of outage at 600 spans/s fit with room to spare. Beyond the queue, new batches are refused and counted in the agent's `otelcol_exporter_enqueue_failed_*` metrics.
- **Delivery is at least once.** A request that times out after the receiver accepted it is retried, which caused the single duplicated Python log record above.

**Test-harness notes:**
- The first agent-restart runs started the agent from inside the test process, so the agent and a Postgres restarted by `pg_ctl` died when that task ended. The agent now runs under its own restart loop, and the test only sends SIGTERM.
- The `fault_duration_s` field in `recovery-3-*.json` (34 s) came from a wait loop that never matched its port check. The agent log shows shutdown completing in about 10 ms and the new agent ready 1.1 s later. The wait now polls the agent's health check (`:13133`).

Raw results for the final runs (after the exporter fix): `bench/evidence/recovery/`. Alert-reliability runs (15 checks each; run 1 had 14/15 before a fix, runs 2 and 3 passed 15/15): `bench/evidence/alerts/`.
