# Multi-hour soak and ramp

`soak.js` runs ingestion, UI queries and monitors together for `SOAK_HOURS`. It tracks resource use, latency and loss over time, then ramps the load until something gives.

```bash
SOAK_HOURS=3 RUN=soak3h node bench/soak/soak.js      # soak, then ramp
RAMP_ONLY=1 RUN=ramp2 node bench/soak/soak.js        # ramp only
```

Set `MONITORING_URL`, `MONITORING_EMAIL`, `MONITORING_PASSWORD` and `MONITORING_API_KEY`, and run it on the same machine (and in the same process namespace) as the server and Postgres, so per-process CPU and memory can be sampled. The script records:

| File | Contents |
|---|---|
| `samples.jsonl` | Once per minute: server and Postgres memory, server CPU, machine CPU, database size, rows inserted per second, intake p50/p99 from the load generator, load generator errors, and monitor evaluation freshness |
| `probes.jsonl` | Every 5 minutes: 15 UI API calls timed (APM services and service page, trace search and view, log search, full-text, histogram and facets, metric queries including high cardinality, hosts, host map, dashboards, monitors) |
| `loadgen-*.jsonl` | Every 10 s: what the load generator sent, its intake latency and errors |
| `summary.json` | Sent vs stored counts, monitor events and final states, ramp steps |

## Setup

- **Load:** `bench/scale/loadgen.js` straight to intake at 400 traces/s: 200 hosts, 50 services, about 2,400 spans/s, 400 logs/s, host metrics for every host, and a 20,000-series custom metric. Every record is tagged `loadtest.run=<RUN>`, so stored counts can be checked against what was sent.
- **Monitors:** 20 monitors evaluate on the normal 30 s schedule: 19 that should stay OK (metric, span, log and high-cardinality queries) and one planted to stay in Alert.
- **Hardware:** one 4 vCPU / 11 GB Linux VM runs the server, Postgres, the load generator and the demo apps.

## Results: 3-hour soak (Nov 12, 2026, 07:35–10:35 UTC, raw data in `bench/evidence/soak-3h/`)

| Measure | Result |
|---|---|
| Spans sent / stored | 26,056,846 / 26,056,846: **0 lost** |
| Logs sent / stored | 4,399,585 / 4,399,585: **0 lost** |
| Metric points sent | 3,310,000 |
| Load generator errors | **0** over 90,223 requests |
| Rows inserted per second | median 6,070 (min 5,872, max 6,339), flat for 3 hours |
| Intake latency | p50 median 38 ms; p99 median 244 ms, with occasional single-window spikes up to 5.9 s |
| Monitors | All 20 evaluated throughout: freshness median 10 s, worst 40 s. The 19 "should be OK" monitors stayed OK with 0 state changes; the planted one alerted once and stayed in Alert |
| Server memory (RSS) | 204–610 MB, median 371 MB, ending at 361 MB: no growth trend |
| Server CPU | 10–15% of one core |
| Postgres memory | 1.2–3.1 GB (shared buffers and caches) |
| Database size | 22.1 GB → 48.5 GB |

**UI queries over the soak** (from `bench/evidence/soak-3h/probes.jsonl`, 37 rounds, all HTTP 200). Median ms per hour, then p90 over all rounds:

| Endpoint | Hour 1 | Hour 2 | Hour 3 | p90 |
|---|---:|---:|---:|---:|
| Monitors list | 5 | 5 | 5 | 9 |
| Dashboards | 3 | 7 | 4 | 15 |
| Trace view | 5 | 4 | 4 | 20 |
| Log facets | 57 | 61 | 70 | 104 |
| Host map | 65 | 73 | 73 | 203 |
| Log full-text | 87 | 94 | 98 | 366 |
| Hosts | 108 | 113 | 195 | 1,448 |
| APM service page | 298 | 261 | 367 | 971 |
| Log histogram | 367 | 438 | 507 | 724 |
| APM services | 371 | 557 | 606 | 1,579 |
| Metric query | 128 | 393 | 475 | 1,262 |
| Trace search | 12 | 9 | 866 | 2,480 |
| Log search `service:… status:error` | 632 | 814 | 1,227 | 9,856 |
| High-cardinality metric | 1,256 | 1,295 | 1,352 | 2,468 |
| Trace metric | 1,047 | 1,812 | 2,467 | 6,185 |

Every value is in `bench/evidence/soak-3h/probes.jsonl`.

**Reading:** ingest held its rate with no loss, and memory stayed flat, for 3 hours. Monitors kept evaluating on time. Queries that scan the most recent rows of a service (trace search, log search with `status:error`, trace metrics) slowed as the database more than doubled, but stayed within seconds. The p90 of log search reached about 10 s while ingest ran at full rate. That is the clearest limit of single-node Postgres storage at this volume.

## Ramp: breaking point (Nov 12, 2026, right after the soak, on the 48.5 GB database)

Each step runs 180 s, with the same mix as the soak (6 spans and about 1 log per trace, host and custom metrics). A step "breaks" when the achieved rate falls below 95% of the target, the **sustained** intake p99 (90th percentile of the 10-second windows) exceeds the limit, or errors appear.
- `out/ramp2`: limit 2 s.
- `out/ramp3`: limit relaxed to 30 s, to find where throughput itself gives out.

The VM has 4 cores and also runs the load generator, the demo apps and the agent.

| Traces/s offered | Achieved | Spans/s achieved | Intake p50 | Sustained p99 | Worst 10 s window | Errors | Server CPU (max, 1 core = 100%) | Postgres CPU (max) | Machine CPU (max) | Monitor freshness (worst) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 400 | 100% | 2,413 | 41 ms | 0.64 s | 3.7 s | 0 | 13% | 23% | 22% | 5 s |
| 800 | 99% | 4,793 | 113 ms | **3.1 s** | 15.6 s | 0 | 20% | 41% | 32% | 33 s |
| 1,200 | 98% | 7,103 | 229 ms | 2.7 s | 10.7 s | 0 | 30% | 63% | 48% | 41 s |
| 1,600 | **70%** | 6,812 | 366 ms | 6.4 s | 9.5 s | **3** | 38% | **95%** | 51% | **101 s** |

**What breaks first:**
1. **Intake latency.** At 800 traces/s (about 4,800 spans/s, 2× the soak), everything is still ingested, but sustained p99 passes 2 s. This is where the strict ramp stopped.
2. **Throughput.** Ingest tops out at about 7,000 spans/s (about 1,200 traces/s), with Postgres near one full core of CPU (95%). At 1,600 traces/s offered, only 70% got in, 3 requests failed, and monitor evaluations fell 101 s behind.

The Monitoring server itself never exceeded 38% of one core, and the machine never exceeded about half its CPU. The limit is Postgres write throughput for a single node (inserts plus index maintenance on `spans`, `logs` and `metric_points`), not the API process. The ways to go beyond this are documented, not built:
- batching span inserts with `COPY`;
- partitioning the telemetry tables by time;
- or a columnar store for spans and logs.

For a single-node install, plan on about 2,500–5,000 spans/s for a comfortable p99 under 2 s, and about 7,000 spans/s as the hard ceiling on this class of machine.


The first ramp attempt (`bench/evidence/soak-3h/summary.json` → `ramp_first_attempt`) stopped at its first step, 400 traces/s, because a single 10-second window had p99 10.5 s; the other 17 windows were between 133 and 1,976 ms. The ramp now uses the **sustained** p99, the 90th percentile of the 10-second windows, and still records the worst window.

Notes:
- The soak's own log count originally reported 0 stored logs. Its query looked for `loadtest.run` in log attributes, but resource attributes are stored as log tags. The query is fixed, and the count was redone: 4,399,585.
- Per-process Postgres CPU is not reported. Short-lived backends exit between samples, which makes the summed CPU unreliable (it can go negative). Machine-wide CPU is sampled from `/proc/stat` instead.
- A VM restart interrupted an earlier soak after 64 minutes; its data was stable throughout.
