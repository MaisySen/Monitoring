# Acme Shop: a demo shop that sends real telemetry to Monitoring

Five small services instrumented with the Monitoring libraries (`@monitoring/trace`, `monitoring-trace`), plus a traffic generator
that simulates shoppers. It is what the README GIFs were recorded with.

| Service | Stack | Emits |
| --- | --- | --- |
| web-gateway | Node, Express | traces, `acme.checkout.*` metrics, JSON logs |
| cart-service | Node, Express, Postgres | traces with Postgres spans, logs |
| payments-service | Node, Express, Postgres | traces, card declines as error logs |
| catalog-service | Python, Flask, SQLite | traces with SQLite spans, warning logs |
| order-worker | Python | custom spans, `acme.queue.depth`, `acme.orders.fulfilled`, `acme.fulfillment.duration` |

## Run it

Needs Node 22+, Python 3.10+, `psql` and a Postgres database for the shop (separate from Monitoring's).

```sh
cd examples/acme-shop
npm install
python3 -m venv .venv && .venv/bin/pip install -e '../../sdks/python[instrumentation]' flask requests
.venv/bin/monitoring-bootstrap -a install
createdb shop                                      # or set ACME_DATABASE_URL
MONITORING_URL=http://localhost:3000 MONITORING_API_KEY=<api key> ./run.sh
```

Leave `MONITORING_URL` unset to send through a local Monitoring Agent on `localhost:4318` instead. Logs are written to
`/tmp/acme-shop` (`ACME_LOG_DIR`) for local debugging; they also reach Monitoring through the libraries.

Import `dashboard.json` from **Dashboards → New → Import JSON** for a ready-made overview.

## Break it on purpose

`bash ../../bench/incident/inject.sh on` makes cart-service query a column that does not exist, the kind of bug a
bad deploy ships: checkouts start failing, and a trace monitor on error spans alerts within about a minute.
`inject.sh off` fixes it. `inject.sh deploy-bad` / `rollback` do the same as a versioned "deploy" with a deploy
event, which Monitoring's **What changed** panel on the monitor page picks up. See `bench/incident/README.md`.
