#!/bin/bash
# Times Monitoring's difficult queries (the API calls the UI makes) while ingestion is running.
# usage: hard-queries.sh <label>  -> one JSON line per query: median of 3 runs, ms
BASE=${MONITORING_URL:-http://localhost:3000}
LABEL=${1:-run}
curl -s -c /tmp/cj-hq -o /dev/null -H 'content-type: application/json' -X POST \
  --data "{\"email\":\"${MONITORING_EMAIL:?set MONITORING_EMAIL}\",\"password\":\"${MONITORING_PASSWORD:?set MONITORING_PASSWORD}\"}" "$BASE/api/auth/login"
NOW=$(date +%s); H1=$((NOW-3600)); D1=$((NOW-86400)); D7=$((NOW-604800))
q() { # name method path [body]
  local name=$1 method=$2 path=$3 body=$4 times=() code bytes
  for i in 1 2 3; do
    if [ "$method" = GET ]; then out=$(curl -s -b /tmp/cj-hq -o /tmp/hq-body -w "%{http_code} %{time_total}" --max-time 120 "$BASE$path")
    else out=$(curl -s -b /tmp/cj-hq -o /tmp/hq-body -w "%{http_code} %{time_total}" --max-time 120 -H 'content-type: application/json' -X POST --data "$body" "$BASE$path"); fi
    set -- $out; code=$1; times+=($(awk -v s=$2 'BEGIN{printf "%d", s*1000}'))
  done
  med=$(printf "%s\n" "${times[@]}" | sort -n | sed -n 2p)
  echo "{\"label\":\"$LABEL\",\"query\":\"$name\",\"status\":$code,\"median_ms\":$med,\"runs_ms\":[$(IFS=,; echo "${times[*]}")],\"bytes\":$(stat -c %s /tmp/hq-body)}"
}
# high cardinality (20,000 customer series)
q highcard_by_plan_1h POST /api/ui/metrics/query "{\"queries\":[{\"name\":\"a\",\"query\":\"sum:scale.orders.placed{*} by {plan}.as_count()\"}],\"from\":$H1,\"to\":$NOW}"
q highcard_total_1h POST /api/ui/metrics/query "{\"queries\":[{\"name\":\"a\",\"query\":\"sum:scale.orders.placed{*}.as_count()\"}],\"from\":$H1,\"to\":$NOW}"
q highcard_top_customers_1h POST /api/ui/metrics/query "{\"queries\":[{\"name\":\"a\",\"query\":\"top(sum:scale.orders.placed{*} by {customer.id}.as_count(), 10, 'sum', 'desc')\"}],\"from\":$H1,\"to\":$NOW}"
# long time ranges
q hosts_cpu_7d POST /api/ui/metrics/query "{\"queries\":[{\"name\":\"a\",\"query\":\"avg:system.cpu.user{*} by {host}\"}],\"from\":$D7,\"to\":$NOW}"
q apm_services_7d GET "/api/ui/apm/services?env=*&from=$D7&to=$NOW"
q apm_service_page_7d GET "/api/ui/apm/services/svc-00?env=*&from=$D7&to=$NOW"
q logs_histogram_7d POST /api/ui/logs/histogram "{\"query\":\"*\",\"from\":$D7,\"to\":$NOW}"
q trace_metric_7d POST /api/ui/metrics/query "{\"queries\":[{\"name\":\"a\",\"query\":\"sum:trace.http.server.request.hits{env:scale} by {service}.as_count()\"}],\"from\":$D7,\"to\":$NOW}"
# large searches
q logs_fulltext_24h POST /api/ui/logs/search "{\"query\":\"upstream failed\",\"from\":$D1,\"to\":$NOW,\"limit\":100}"
q logs_service_errors_24h POST /api/ui/logs/search "{\"query\":\"service:svc-00 status:error\",\"from\":$D1,\"to\":$NOW,\"limit\":100}"
q logs_facets_24h POST /api/ui/logs/facets "{\"query\":\"*\",\"from\":$D1,\"to\":$NOW}"
q logs_attr_search_24h POST /api/ui/logs/search "{\"query\":\"@customer.id:cust-1234\",\"from\":$D1,\"to\":$NOW,\"limit\":100}"
q spans_search_24h POST /api/ui/apm/spans "{\"query\":\"service:svc-00 status:error\",\"from\":$D1,\"to\":$NOW,\"limit\":100}"
q spans_facets_24h POST /api/ui/apm/spans/facets "{\"query\":\"env:scale\",\"from\":$D1,\"to\":$NOW}"
q logs_aggregate_by_service_24h POST /api/ui/logs/aggregate "{\"query\":\"status:error\",\"groupBy\":\"service\",\"type\":\"toplist\",\"from\":$D1,\"to\":$NOW}"
