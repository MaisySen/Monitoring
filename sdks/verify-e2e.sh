#!/usr/bin/env bash
# Run from a checkout with both SDK dependencies installed. Never prints the key.
set -euo pipefail
cd "$(dirname "$0")"
export MONITORING_URL="${MONITORING_URL:-http://localhost:3000}"
: "${MONITORING_API_KEY:?Set MONITORING_API_KEY}"
export MONITORING_API_KEY
export MONITORING_VERIFY_REMOTE=true
node node/test/verify.js
python/.venv/bin/python python/tests/verify.py
psql "${DATABASE_URL:-postgresql://monitoring:monitoring@localhost/monitoring}" -v ON_ERROR_STOP=1 <<'SQL'
SELECT service, count(*) AS spans FROM spans
WHERE service IN ('monitoring-node-verify','monitoring-python-verify') GROUP BY service;
SELECT service, count(*) AS correlated_logs FROM logs
WHERE service IN ('monitoring-node-verify','monitoring-python-verify')
AND trace_id IS NOT NULL AND trace_id <> '' GROUP BY service;
SELECT metric, count(*) AS series FROM metric_series
WHERE metric IN ('monitoring.example.node.requests','monitoring.example.python.requests') GROUP BY metric;
DO $$
DECLARE service_name text;
BEGIN
  FOREACH service_name IN ARRAY ARRAY['monitoring-node-verify','monitoring-python-verify'] LOOP
    IF NOT EXISTS (SELECT 1 FROM spans WHERE service = service_name) THEN
      RAISE EXCEPTION 'Missing spans for %', service_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logs l JOIN spans s ON l.trace_id = s.trace_id
                   WHERE l.service = service_name AND s.service = service_name) THEN
      RAISE EXCEPTION 'Missing correlated logs for %', service_name;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT metric) FROM metric_series WHERE metric IN
      ('monitoring.example.node.requests','monitoring.example.python.requests')) <> 2 THEN
    RAISE EXCEPTION 'Missing SDK custom metrics';
  END IF;
END $$;
SQL
