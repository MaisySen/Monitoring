#!/usr/bin/env bash
# Regression check: the published "with a local agent" onboarding path, verbatim:
# the Docs run line carries NO MONITORING_URL/MONITORING_API_KEY; the SDK defaults
# to http://localhost:4318, where the Monitoring Agent receives OTLP and forwards
# to the server with its configured key.
#
#   MONITORING_SERVICE=checkout MONITORING_ENV=prod MONITORING_VERSION=1.0.0 \
#   node -r @monitoring/trace/init app.js
#
# Starts the served agent binary against a scratch state dir with an
# example-derived config, runs the line verbatim, asserts a span lands with the
# version/env recorded. Uses bench/lib/procs.sh for ownership-scoped process
# management (kills only what it started).
#
# Usage: SERVER_URL=http://127.0.0.1:4731 API_KEY=... PGDATABASE=valrun \
#        bench/regression/onboarding-agent-compose.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/bench/lib/procs.sh"
: "${SERVER_URL:?set SERVER_URL}" "${API_KEY:?set API_KEY}" "${PGDATABASE:?set PGDATABASE}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5433}" PGUSER="${PGUSER:-monitoring}"
APP_PORT="${APP_PORT:-4936}"
command -v psql >/dev/null || export PATH="$HOME/pgsql/usr/lib/postgresql/14/bin:$PATH"

WORK="$(mktemp -d)"
export OWN_DIR="$WORK/owned"
cleanup() { own_stop_all; rm -rf "$WORK"; }
trap cleanup EXIT

# 1. Fetch the served agent binary (same artifact the installer would install).
curl -fsS "$SERVER_URL/downloads/monitoring-agent-linux-amd64" -o "$WORK/agent"
chmod +x "$WORK/agent"
[ "$(od -A n -t x1 -N 4 "$WORK/agent" | tr -d ' \n')" = "7f454c46" ] || { echo "FAIL: served agent is not an ELF"; exit 1; }

# 2. Example-derived config (monitoring.example.yaml shape; local-only, metrics off).
mkdir -p "$WORK/state"
cat > "$WORK/agent.yaml" <<YAML
api_key: $API_KEY
url: $SERVER_URL
env: prod
host_metrics:
  enabled: false
listen: 127.0.0.1
state_dir: $WORK/state
apm:
  otlp: true
  datadog_compat: false
dogstatsd:
  enabled: false
logs: []
YAML
own_start agent "$WORK/agent" run -c "$WORK/agent.yaml" > /dev/null

ready=""
for _ in $(seq 1 20); do
  sleep 1
  curl -s -o /dev/null "http://127.0.0.1:4318/v1/traces" && { ready=1; break; }
done
[ -n "$ready" ] || { echo "FAIL: agent OTLP receiver did not come up on 4318"; tail -5 "$OWN_DIR/agent.log"; exit 1; }

# 3. Minimal app + verbatim Docs "with agent" run line (no MONITORING_URL/KEY).
mkdir -p "$WORK/app"
cat > "$WORK/app/app.js" <<JS
const http = require("http");
http.createServer((req, res) => { res.end("ok"); }).listen($APP_PORT, "127.0.0.1");
JS
( cd "$WORK/app" && npm install --silent "$SERVER_URL/downloads/monitoring-trace-0.1.0.tgz" ) > "$WORK/npm.log" 2>&1

before=$(psql -d "$PGDATABASE" -t -A -c "select count(*) from spans where service='checkout'")
( cd "$WORK/app" && own_start app env MONITORING_SERVICE=checkout MONITORING_ENV=prod MONITORING_VERSION=1.0.0 node -r @monitoring/trace/init app.js > /dev/null )

ok=""
for _ in $(seq 1 15); do
  sleep 1
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/ok" || true)" = "200" ] && { ok=1; break; }
done
[ -n "$ok" ] || { echo "FAIL: app did not answer on :$APP_PORT"; exit 1; }
sleep 8

after=$(psql -d "$PGDATABASE" -t -A -c "select count(*) from spans where service='checkout'")
ver=$(psql -d "$PGDATABASE" -t -A -c "select version || '/' || env from service_versions where service='checkout' and version='1.0.0' and env='prod'")
if [ "$after" -gt "$before" ] && [ "$ver" = "1.0.0/prod" ]; then
  echo "PASS: spans $before -> $after via agent forward; service_versions has checkout 1.0.0/prod (verbatim agent path works)"
else
  echo "FAIL: spans $before -> $after, service_versions row: '${ver:-none}'"
  exit 1
fi
