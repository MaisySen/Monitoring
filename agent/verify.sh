#!/usr/bin/env bash
# Starts only a temporary Monitoring Agent; never manages core application services.
set -euo pipefail
cd "$(dirname "$0")"
: "${MONITORING_API_KEY:?Set MONITORING_API_KEY without printing it}"
export MONITORING_URL="${MONITORING_URL:-http://localhost:3000}"
export VERIFY_HOST="${VERIFY_HOST:-monitoring-agent-verify-$(hostname)}"
export VERIFY_DIR
VERIFY_DIR=$(mktemp -d /tmp/monitoring-agent-verify.XXXXXX)
chmod 700 "$VERIFY_DIR"
export SMOKE_LOG_PATH="$VERIFY_DIR/smoke.log"
export SMOKE_EVIDENCE_PATH="$VERIFY_DIR/evidence.json"
touch "$SMOKE_LOG_PATH"
export VERIFY_SOURCE="$PWD/monitoring.example.yaml"
node --input-type=module <<'JS'
import fs from "node:fs";
let config = fs.readFileSync(process.env.VERIFY_SOURCE, "utf8")
  .replace("api_key: ${MONITORING_API_KEY}", `api_key: ${JSON.stringify(process.env.MONITORING_API_KEY)}`)
  .replace("url: http://localhost:3000", `url: ${JSON.stringify(process.env.MONITORING_URL)}`)
  .replace("# hostname: my-host", `hostname: ${JSON.stringify(process.env.VERIFY_HOST)}`)
  .replace("env: prod", "env: agent-verify")
  .replace("state_dir: /var/lib/monitoring-agent", `state_dir: ${process.env.VERIFY_DIR}/state`)
  .replaceAll("    source: nodejs", "    source: nodejs\n    start_at: beginning")
  .replace("# Debug output", `  - path: ${process.env.SMOKE_LOG_PATH}\n    service: monitoring-agent-smoke\n    source: verification\n    start_at: beginning\n# Debug output`)
  .replace("debug: false", "debug: true");
fs.writeFileSync(`${process.env.VERIFY_DIR}/config.yaml`, config, { mode: 0o600 });
JS
AGENT="${AGENT:-/opt/monitoring-agent/bin/monitoring-agent}"
"$AGENT" run -c "$VERIFY_DIR/config.yaml" > "$VERIFY_DIR/debug.log" 2>&1 &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  kill -0 "$PID" || { echo "Agent failed; inspect $VERIFY_DIR/debug.log"; exit 1; }
  if curl -fsS http://127.0.0.1:13133/ > /dev/null; then break; fi
  sleep 0.2
done
node smoke.mjs
# Two host scrapes are needed for delta counters; the StatsD interval is 15s.
sleep 40
kill -TERM "$PID"
wait "$PID"
trap - EXIT
for expected in 'system.cpu.utilization' 'Monitoring Agent end-to-end verification' 'GET /agent-smoke' 'GET /compat-smoke'; do
  grep -q "$expected" "$VERIFY_DIR/debug.log" || { echo "Missing debug evidence: $expected"; exit 1; }
done
TRACE=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.SMOKE_EVIDENCE_PATH)).trace_id')
COMPAT_TRACE=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.SMOKE_EVIDENCE_PATH)).migration_trace_id')
# Row checks below read Postgres storage; with MONITORING_STORAGE=clickhouse, check the host in the UI instead.
DB="${DATABASE_URL:-postgresql://monitoring:monitoring@localhost/monitoring}"
psql "$DB" -v ON_ERROR_STOP=1 -v host="$VERIFY_HOST" -v trace="$TRACE" -v compat="$COMPAT_TRACE" <<'SQL'
SELECT name, os, agent_version, tags FROM hosts WHERE name = :'host';
SELECT count(*) AS metric_series, count(DISTINCT metric) AS metric_names
  FROM metric_series WHERE host = :'host';
SELECT metric, type FROM metric_series WHERE host = :'host' AND metric LIKE 'monitoring.agent.smoke.%';
SELECT service, count(*) AS logs, count(trace_id) AS correlated FROM logs WHERE host = :'host' GROUP BY service ORDER BY service;
SELECT service, trace_id, span_id, resource, env, host FROM spans WHERE trace_id IN (:'trace', :'compat');
SELECT service, message, trace_id FROM logs WHERE trace_id = :'trace';
SQL
echo "Debug exporter and evidence: $VERIFY_DIR (contains telemetry and a credential-bearing config; keep private)"
