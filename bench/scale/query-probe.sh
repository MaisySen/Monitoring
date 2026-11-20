#!/bin/bash
# Times the API calls behind Monitoring's core screens (what the UI fetches) over the last hour.
# usage: query-probe.sh [label]   — prints one JSON line per endpoint with wall time in ms.
# Logs in with MONITORING_EMAIL / MONITORING_PASSWORD (cookie jar /tmp/cj-probe).
BASE=${MONITORING_URL:-http://localhost:3000}
LABEL=${1:-probe}
curl -s -c /tmp/cj-probe -o /dev/null -H 'content-type: application/json' -X POST \
  --data "{\"email\":\"${MONITORING_EMAIL:?set MONITORING_EMAIL}\",\"password\":\"${MONITORING_PASSWORD:?set MONITORING_PASSWORD}\"}" "$BASE/api/auth/login"
NOW=$(date +%s); FROM=$((NOW-3600))
t() { # name method path [json-body]
  local name=$1 method=$2 path=$3 body=$4 out
  if [ "$method" = GET ]; then out=$(curl -s -b /tmp/cj-probe -o /tmp/probe-body -w "%{http_code} %{time_total}" "$BASE$path")
  else out=$(curl -s -b /tmp/cj-probe -o /tmp/probe-body -w "%{http_code} %{time_total}" -H 'content-type: application/json' -X POST --data "$body" "$BASE$path"); fi
  set -- $out
  echo "{\"label\":\"$LABEL\",\"endpoint\":\"$name\",\"status\":$1,\"ms\":$(awk -v s=$2 'BEGIN{printf "%d", s*1000}'),\"bytes\":$(stat -c %s /tmp/probe-body)}"
}
t apm_services GET "/api/ui/apm/services?env=*&from=$FROM&to=$NOW"
t apm_service_page GET "/api/ui/apm/services/svc-00?env=*&from=$FROM&to=$NOW"
t trace_search POST "/api/ui/apm/spans" "{\"query\":\"service:svc-00 status:error\",\"from\":$FROM,\"to\":$NOW,\"limit\":50}"
TRACE=$(psql "${DATABASE_URL:?set DATABASE_URL}" -tAc "select trace_id from spans where service='svc-00' and start_ms > ($NOW::bigint-600)*1000 limit 1")
t trace_view GET "/api/ui/apm/traces/$TRACE"
t logs_search POST "/api/ui/logs/search" "{\"query\":\"service:svc-00 status:error\",\"from\":$FROM,\"to\":$NOW,\"limit\":100}"
t logs_fulltext POST "/api/ui/logs/search" "{\"query\":\"upstream failed\",\"from\":$FROM,\"to\":$NOW,\"limit\":100}"
t logs_histogram POST "/api/ui/logs/histogram" "{\"query\":\"*\",\"from\":$FROM,\"to\":$NOW}"
t logs_facets POST "/api/ui/logs/facets" "{\"query\":\"*\",\"from\":$FROM,\"to\":$NOW}"
t metric_query POST "/api/ui/metrics/query" "{\"queries\":[{\"name\":\"a\",\"query\":\"avg:system.cpu.user{*} by {host}\"}],\"from\":$FROM,\"to\":$NOW}"
t metric_highcard POST "/api/ui/metrics/query" "{\"queries\":[{\"name\":\"a\",\"query\":\"sum:scale.orders.placed{*} by {plan}.as_count()\"}],\"from\":$FROM,\"to\":$NOW}"
t trace_metric POST "/api/ui/metrics/query" "{\"queries\":[{\"name\":\"a\",\"query\":\"sum:trace.http.server.request.hits{env:scale} by {service}.as_count()\"}],\"from\":$FROM,\"to\":$NOW}"
t hosts GET "/api/ui/hosts?from=$FROM&to=$NOW"
t hostmap POST "/api/ui/hostmap" "{\"fill\":\"avg:system.cpu.user{*}\",\"from\":$FROM,\"to\":$NOW}"
t dashboards GET "/api/v1/dashboard"
t monitors GET "/api/v1/monitor"
