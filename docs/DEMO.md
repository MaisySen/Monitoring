# Scripted end-to-end demo

This demo stands up Monitoring on a fresh Postgres database, fills it with known-answer
telemetry (metrics, logs, traces), and captures UI screenshots with headless Chrome.

## Steps

1. Build and start the server on an empty database (see docs/ENGINEERING_STATE.md for the
   local Postgres setup):

   ```sh
   pnpm run build:selfhost
   NODE_ENV=production PUBLIC_URL=http://127.0.0.1:3100 PORT=3100 \
     DATABASE_URL=postgres://monitoring@127.0.0.1:5433/demo \
     MONITORING_SETUP_TOKEN=e2etoken123 SESSION_SECRET=<32+ chars> \
     node artifacts/api-server/dist/index.mjs
   ```

2. Populate it with the benchmark kit's known-answer workload (this also performs first-run
   setup and creates the keys):

   ```sh
   MONITORING_URL=http://127.0.0.1:3100 MONITORING_SETUP_TOKEN=e2etoken123 \
     E2E_EMAIL=demo@monitoring.local E2E_PASSWORD=demo-pass-12345 \
     LABEL=demo PROFILE=quick bash scripts/e2e.sh
   ```

   The script fails unless every known answer (metric values, log contents, trace spans)
   comes back correct, so the demo data is verified, not just written.

3. Optional: set org quotas and a second organization so Usage & Limits and the org
   switcher have something to show:

   ```sh
   curl -c c -H 'content-type: application/json' -X POST \
     --data '{"email":"demo@monitoring.local","password":"demo-pass-12345"}' \
     http://127.0.0.1:3100/api/auth/login
   curl -b c -H 'content-type: application/json' -X PUT \
     --data '{"maxLogsPerDay":100000,"maxPointsPerDay":500000,"maxSpansPerDay":50000,"maxSeries":10000,"maxIngestBytesPerMinute":52428800}' \
     http://127.0.0.1:3100/api/ui/org/quotas
   curl -b c -H 'content-type: application/json' -X POST \
     --data '{"name":"Payments Team"}' http://127.0.0.1:3100/api/ui/orgs
   ```

4. Capture the UI (requires Chrome and `puppeteer-core`; the script is not part of the
   package dependencies):

   ```sh
   BASE=http://127.0.0.1:3100 OUT=/downloads/m4-demo node demo-shots.mjs
   ```

## What the screenshots show

- `00-login` - signed-out login page
- `01-home` - home overview with live service health, host and log counts
- `02-metric-explorer` - metrics explorer
- `03-logs` - log explorer with 10k ingested logs, facets by status/service/host
- `04-traces` - APM trace explorer with 8000 spans across four demo services
- `05-services` - service catalog
- `06-usage-limits` - Usage & Limits: per-day quotas with usage today, editable limits,
  and the stored/dropped intake counters with last drop reason
- `07-organizations` - Organizations panel: memberships with roles, create-org,
  join-with-invite
- `08-agent-setup` - agent installation page
- `09-org-switcher` - sidebar org switcher with two memberships
