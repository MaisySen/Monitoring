#!/usr/bin/env bash
# Regression check: the published Datadog-compat API commands (Docs "Datadog API"
# section), run verbatim with only URL/key placeholders substituted, must actually
# work: metrics series, logs, events (API+app key), monitor create, plus a
# wrong-app-key negative control.
#
# Usage: SERVER_URL=http://127.0.0.1:4731 API_KEY=... APP_KEY=... bench/regression/onboarding-dd-compat.sh
# (APP_KEY: an application key from Organization Settings -> Application Keys.)
set -euo pipefail
: "${SERVER_URL:?set SERVER_URL}" "${API_KEY:?set API_KEY}" "${APP_KEY:?set APP_KEY}"
MARK="ddreg$(date +%s)"
fail=0

# 1. Published v2/series command, verbatim shape.
code=$(curl -s -o /tmp/ddreg-series.json -w '%{http_code}' -X POST "$SERVER_URL/api/v2/series" \
  -H "DD-API-KEY: $API_KEY" -H "Content-Type: application/json" \
  -d '{"series":[{"metric":"shop.orders","type":1,"points":[{"timestamp":'$(date +%s)',"value":3}],"tags":["env:prod","reg:'"$MARK"'"],"resources":[{"type":"host","name":"web-1"}]}]}')
[ "$code" = "202" ] || [ "$code" = "200" ] || { echo "FAIL [series]: $code $(head -c 120 /tmp/ddreg-series.json)"; fail=1; }
sleep 2
got=$(curl -s -G "$SERVER_URL/api/v1/query" --data-urlencode "from=$(($(date +%s)-300))" --data-urlencode "to=$(($(date +%s)+60))" --data-urlencode "query=sum:shop.orders{reg:$MARK}" \
  -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY" | grep -c 'shop.orders' || true)
if [ "$code" = "202" ] || [ "$code" = "200" ]; then
  [ "$got" -ge 1 ] && echo "PASS [series]: published command accepted and point queryable" || { echo "FAIL [series]: accepted but not queryable"; fail=1; }
fi

# 2. Published v2/logs command, verbatim shape.
code=$(curl -s -o /tmp/ddreg-logs.json -w '%{http_code}' -X POST "$SERVER_URL/api/v2/logs" \
  -H "DD-API-KEY: $API_KEY" -H "Content-Type: application/json" \
  -d '[{"message":"user signed up '"$MARK"'","service":"web","ddsource":"curl","hostname":"web-1","status":"info","ddtags":"env:prod","usr":{"id":42}}]')
sleep 2
found=$(curl -s -X POST "$SERVER_URL/api/v2/logs/events/search" \
  -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY" -H "Content-Type: application/json" \
  -d '{"filter":{"query":"'"$MARK"'","from":"0"}}' | grep -c "$MARK" || true)
if [ "$code" = "202" ] || [ "$code" = "200" ]; then
  [ "$found" -ge 1 ] && echo "PASS [logs]: published command accepted and log searchable" || { echo "FAIL [logs]: accepted ($code) but not searchable"; fail=1; }
else
  echo "FAIL [logs]: $code $(head -c 120 /tmp/ddreg-logs.json)"; fail=1
fi

# 3. Published v1/events command (API key + application key), verbatim shape.
code=$(curl -s -o /tmp/ddreg-event.json -w '%{http_code}' -X POST "$SERVER_URL/api/v1/events" -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY" \
  -H "Content-Type: application/json" -d '{"title":"Deployed v1.4.2 '"$MARK"'","text":"checkout","tags":["service:checkout"]}')
ev=$(curl -s "$SERVER_URL/api/v1/events" -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY" | grep -c "$MARK" || true)
if [ "$code" = "202" ] || [ "$code" = "200" ] || [ "$code" = "201" ]; then
  [ "$ev" -ge 1 ] && echo "PASS [events]: published command accepted and event listed" || { echo "FAIL [events]: accepted ($code) but not listed"; fail=1; }
else
  echo "FAIL [events]: $code $(head -c 120 /tmp/ddreg-event.json)"; fail=1
fi

# 4. Published v1/monitor create command, verbatim shape (then cleaned up).
code=$(curl -s -o /tmp/ddreg-monitor.json -w '%{http_code}' -X POST "$SERVER_URL/api/v1/monitor" -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY" \
  -H "Content-Type: application/json" -d '{
    "name": "Checkout errors '"$MARK"'", "type": "log alert",
    "query": "logs(\"service:checkout status:error\").index(\"*\").rollup(\"count\").last(\"5m\") > 5",
    "message": "Checkout errors: {{value}} @webhook-oncall",
    "options": {"thresholds": {"critical": 5}}
  }')
mon=$(curl -s "$SERVER_URL/api/v1/monitor" -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY" | grep -c "$MARK" || true)
if { [ "$code" = "200" ] || [ "$code" = "201" ]; } && [ "$mon" -ge 1 ]; then
  echo "PASS [monitor]: published command created a listed monitor"
  mid=$(curl -s "$SERVER_URL/api/v1/monitor" -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  [ -n "$mid" ] && curl -s -o /dev/null -X DELETE "$SERVER_URL/api/v1/monitor/$mid" -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: $APP_KEY"
else
  echo "FAIL [monitor]: create $code, listed matches $mon. $(head -c 160 /tmp/ddreg-monitor.json)"; fail=1
fi

# 5. Negative control: a wrong application key must be refused.
bad=$(curl -s -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/events" -H "DD-API-KEY: $API_KEY" -H "DD-APPLICATION-KEY: wrong-key")
{ [ "$bad" = "401" ] || [ "$bad" = "403" ]; } && echo "PASS [auth]: wrong application key refused ($bad)" || { echo "FAIL [auth]: wrong app key got $bad"; fail=1; }

[ "$fail" = 0 ] && echo "DD-COMPAT ALL PASSED"
exit "$fail"
