# Benchmark kit: throughput and correctness with known answers

Three scripts send synthetic telemetry to Monitoring through its public API, then check
every answer against a value known in advance. Every result has a correctness column, so a fast but wrong answer
is visible right away. They need Node.js 20+ and nothing else (no npm install).

| Script | Sends | Reads back | Checks |
| --- | --- | --- | --- |
| `metrics-bench.js` | `POST /api/v1/series`: count and gauge series at 1k, 10k and 50k customers (2k–100k series) | `GET /api/v1/query` | total, sum by shard, top 10 of 50k tags, average by shard, max with a tag filter |
| `logs-bench.js` | `POST /api/v2/logs`: 100k logs, 10 services, 1 in 20 errors, a unique token per log | `POST /api/v2/logs/events/search` | find one log among 100k by token, token + service, wrong service must return 0, error counts, phrase search, tag + status |
| `traces-bench.js` | `POST /otlp/v1/traces` (OTLP/HTTP JSON): 20k traces × 5 spans across 4 services, 1 in 25 fails | `POST /api/v2/spans/events/search` | whole trace with one trace ID, one service in a trace, the error span of a failing trace, none in a healthy one, attribute search, errors in one service |

All three also measure ingest throughput, ingest request p50/p99, the time until the last thing sent is
queryable, and median query latency over 3 runs.

## 1. Start Monitoring locally

```sh
git clone https://github.com/replit/monitoring && cd monitoring
cp .env.example .env
# set POSTGRES_PASSWORD and SESSION_SECRET in .env (any long random strings)
docker compose up -d --build                                   # Postgres storage (default)
# or, for ClickHouse storage: set MONITORING_STORAGE=clickhouse and CLICKHOUSE_PASSWORD in .env, then
# docker compose --profile clickhouse up -d --build
curl -s localhost:3000/api/healthz                             # {"status":"ok"}
```

Open http://localhost:3000, create the first account, then go to **Organization Settings** (sidebar) and create one
**API key** and one **Application key**. A clean build takes about 30 seconds on 4 vCPUs.

To test both storage options, run the kit once per option. Switching storage needs a fresh start
(`docker compose down -v`), because telemetry is not migrated between them.

## 2. Run the kit

```sh
cd bench/kit
TARGET=http://localhost:3000 API_KEY=<api key> APP_KEY=<application key> LABEL=monitoring-postgres ./run-all.sh
```

It prints a summary table and writes `results/<LABEL>/{metrics,logs,traces}.json` plus `summary.md`.
`PROFILE=quick` takes about 1 minute, `standard` (default) about 3–5 minutes, and `large` (200k-customer metrics, 500k logs,
100k traces) longer.

## Reference results (Monitoring, Nov 14 2026)

One 4 vCPU / 11 GB Linux VM, Monitoring and its database on the same machine, `standard` profile, concurrency 4.
Every answer was correct in both modes.

| | Postgres storage | ClickHouse storage |
| --- | ---: | ---: |
| Metrics ingest, 100k series | 336,699 points/s | 167,533 points/s |
| Metrics queries over 100k series (median of 5) | 278 ms | 153 ms |
| Metrics fully queryable after ingest | 3.9 s | 0.2 s |
| Log ingest (100k logs) | 110,616 logs/s | 10,884 logs/s (57,616 at concurrency 32) |
| Log search over 100k logs (median of 6) | 43 ms | 20 ms |
| Trace ingest (100k spans) | 45,244 spans/s | 6,320 spans/s (19,460 at concurrency 16) |
| Span search (median of 6) | 10 ms | 62 ms |
| Ingest errors | 0 | 0 |

### Note on ClickHouse ingest

ClickHouse's per-request ingest is slower here because each request waits for ClickHouse to acknowledge its async
insert (`wait_for_async_insert=1`, so a 2xx means the data is stored). Its throughput grows with more concurrent
senders; Postgres's does not. On data volumes past a single Postgres node's comfort zone (hundreds of millions of rows),
see `docs/SELF_HOSTING.md` → "Choosing telemetry storage".
