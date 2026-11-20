# Demo journey (M4)

End-to-end demo environment for Monitoring: a realistic seeded organization plus UI
screenshots of the main surfaces.

## Run

```bash
# 1. fresh database + server (example: port 4610, db demo4)
createdb demo4
NODE_ENV=production PUBLIC_URL=http://127.0.0.1:4610 PORT=4610 \
  DATABASE_URL=postgresql://monitoring@127.0.0.1:5433/demo4 \
  MONITORING_SETUP_TOKEN=demo4-setup-token \
  MONITORING_ALLOW_PRIVATE_WEBHOOKS=true \
  SESSION_SECRET=... node --enable-source-maps ./dist/index.mjs demo4srv &

# 2. seed (account, org, telemetry, dashboard, monitor driven into Alert, second org)
MONITORING_URL=http://127.0.0.1:4610 MONITORING_SETUP_TOKEN=demo4-setup-token \
  node bench/demo/seed-demo.js
# prints DEMO_SUMMARY {...} with dashboardId/monitorId and seeded counts

# 3. screenshots (needs puppeteer-core installed beside this script and a system Chrome;
#    set CHROME_PATH to override /usr/bin/google-chrome)
MONITORING_URL=http://127.0.0.1:4610 DASHBOARD_ID=<id> MONITOR_ID=<id> \
  OUT_DIR=bench/evidence/demo node bench/demo/screenshot-demo.mjs
```

`MONITORING_ALLOW_PRIVATE_WEBHOOKS=true` is required because the demo alert delivers to a
loopback sink; without it the channel API refuses private webhook URLs (by design).

## What the seed proves

- setup + login + API key creation
- OTLP intake of traces, logs and metrics for three services (30 min window, ~5% errors)
- dashboard creation with three timeseries widgets rendering the seeded series
- webhook channel + metric monitor driven into Alert with a real HTTP 200 delivery
- a second organization with its own small dataset for the org switcher

## Captured pages (bench/evidence/demo/)

`apm-services`, `logs`, `dashboard`, `monitors`, `monitor-firing`,
`org-settings-usage`, `org-switcher-open` (each visually verified after capture).
