#!/usr/bin/env bash
# Run the portable benchmark kit (metrics, logs, traces) against one backend and write results/<LABEL>/*.json
# plus a one-screen summary. Needs Node.js 20+ and nothing else.
#
#   TARGET=http://localhost:3000 API_KEY=... APP_KEY=... LABEL=monitoring-postgres ./run-all.sh
#
# Optional: PROFILE=quick|standard|large (default standard), CONCURRENCY (default 4), OTLP_URL (traces intake if the
# backend serves OTLP on another port, e.g. http://localhost:4318/v1/traces).
set -euo pipefail
cd "$(dirname "$0")"
: "${TARGET:?set TARGET, e.g. http://localhost:3000}"; : "${API_KEY:?set API_KEY}"; : "${APP_KEY:?set APP_KEY}"
LABEL="${LABEL:-$(echo "$TARGET" | sed -E 's#https?://##; s#[^a-zA-Z0-9]+#-#g')}"
PROFILE="${PROFILE:-standard}"
case "$PROFILE" in
  quick)    STEPS=1000;              LOGS=10000;  TRACES=2000 ;;
  standard) STEPS=1000,10000,50000;  LOGS=100000; TRACES=20000 ;;
  large)    STEPS=1000,10000,50000,200000; LOGS=500000; TRACES=100000 ;;
  *) echo "PROFILE must be quick, standard or large"; exit 2 ;;
esac
OUT="results/$LABEL"; mkdir -p "$OUT"
export TARGET API_KEY APP_KEY
echo "== $LABEL ($TARGET), profile $PROFILE"
curl -fsS -m 10 -o /dev/null -X POST -H "DD-API-KEY: $API_KEY" -H 'content-type: application/json' --data '{"series":[]}' "$TARGET/api/v1/series" \
  || { echo "metrics intake not reachable or key rejected at $TARGET/api/v1/series"; exit 1; }
echo "-- metrics";  STEPS=$STEPS  node metrics-bench.js > "$OUT/metrics.json" 2> "$OUT/metrics.log"  || echo "metrics failed (see $OUT/metrics.log)"
echo "-- logs";     N=$LOGS       node logs-bench.js    > "$OUT/logs.json"    2> "$OUT/logs.log"     || echo "logs failed (see $OUT/logs.log)"
echo "-- traces";   TRACES=$TRACES node traces-bench.js > "$OUT/traces.json"  2> "$OUT/traces.log"   || echo "traces failed (see $OUT/traces.log)"
node summarize.js "$OUT" | tee "$OUT/summary.md"
