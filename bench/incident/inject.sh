#!/bin/bash
# Incident demo fault switch for the Acme Shop on the Monitoring stack.
#   inject.sh on           cart-service's cart query starts referencing a column that does not exist (every cart lookup and
#                          checkout fails with a Postgres error; the gateway returns 502)
#   inject.sh off          back to the correct query
#   inject.sh deploy-bad   "deploy" cart-service 2.1.0, which ships the faulty query: writes the version, turns the fault on,
#                          restarts cart-service (its run loop picks up the version) and posts a deploy event to Monitoring
#   inject.sh rollback     "deploy" 2.0.0 again with the fault off, and post a rollback event
#   inject.sh status
set -e
FLAG=/tmp/acme-fault/cart-query
# Deploy events go to Monitoring's events API (MONITORING_URL, MONITORING_API_KEY).
EVENTS_URL="${MONITORING_URL:-http://localhost:3000}/api/v1/events"
deploy() { # version message
  echo "$1" > /tmp/acme-cart-version
  pkill -f "[c]art/app.js" || true
  if [ -n "${MONITORING_API_KEY:-}" ]; then
    curl -s -o /dev/null -w "deploy event: HTTP %{http_code}\n" -H 'content-type: application/json' -H "DD-API-KEY: $MONITORING_API_KEY" -X POST "$EVENTS_URL" \
      --data "{\"title\":\"Deployed cart-service $1\",\"text\":\"$2\",\"tags\":[\"service:cart-service\",\"version:$1\",\"deploy\"],\"alert_type\":\"info\"}"
  else
    echo "WARNING: MONITORING_API_KEY not set, deploy event NOT posted" >&2
  fi
}
case "${1:-status}" in
  on)  mkdir -p /tmp/acme-fault && touch "$FLAG" && echo "fault ON since $(date -u +%FT%TZ)";;
  off) rm -f "$FLAG" && echo "fault OFF at $(date -u +%FT%TZ)";;
  deploy-bad) mkdir -p /tmp/acme-fault && touch "$FLAG" && deploy 2.1.0 "cart: aggregate quantity per sku (PR #482)" && echo "deployed cart-service 2.1.0 (faulty query) at $(date -u +%FT%TZ)";;
  rollback) rm -f "$FLAG" && deploy 2.0.0 "rollback of 2.1.0" && echo "rolled back cart-service to 2.0.0 at $(date -u +%FT%TZ)";;
  status) [ -f "$FLAG" ] && echo "fault ON (cart-service $(cat /tmp/acme-cart-version 2>/dev/null || echo 2.0.0))" || echo "fault OFF (cart-service $(cat /tmp/acme-cart-version 2>/dev/null || echo 2.0.0))";;
  *) echo "usage: $0 on|off|deploy-bad|rollback|status"; exit 1;;
esac
