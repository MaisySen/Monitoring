#!/usr/bin/env bash
# Post-run / post-restart cleanup for soak work: stop owned soak processes, remove soak monitors.
# Ownership records live under $HOME/monitoring-owned so they survive a /tmp wipe; safe to run any time.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export OWN_DIR="${OWN_DIR:-$HOME/monitoring-owned}"
. "$ROOT/bench/lib/procs.sh"
own_stop_all
# Loadgen orphans (children of a killed soak) are matched by their own run arg, never by port.
for pid in $(pgrep -f 'bench/scale/loadgen.js' || true); do kill "$pid" 2>/dev/null || true; done
# Remove soak monitors from the target org when credentials are present.
if [ -n "${MONITORING_URL:-}" ] && [ -n "${MONITORING_EMAIL:-}" ]; then
  CJ=$(mktemp)
  curl -s -c "$CJ" -o /dev/null -H 'content-type: application/json' -X POST \
    --data "{\"email\":\"${MONITORING_EMAIL}\",\"password\":\"${MONITORING_PASSWORD:-}\"}" "$MONITORING_URL/api/auth/login"
  for id in $(curl -s -b "$CJ" "$MONITORING_URL/api/v1/monitor" | jq -r '.[]? // empty | select(.name|startswith("soak ")) | .id' 2>/dev/null); do
    curl -s -b "$CJ" -o /dev/null -X DELETE "$MONITORING_URL/api/v1/monitor/$id"
  done
  rm -f "$CJ"
fi
echo "cleanup done (owned processes stopped, soak monitors removed when credentials were set)"
