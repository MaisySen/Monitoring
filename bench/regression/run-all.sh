#!/usr/bin/env bash
# Runs every published-path regression check against a live server.
# Usage: SERVER_URL=http://127.0.0.1:4731 API_KEY=... PGDATABASE=valrun bench/regression/run-all.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
: "${SERVER_URL:?set SERVER_URL}" "${API_KEY:?set API_KEY}" "${APP_KEY:?set APP_KEY}" "${PGDATABASE:?set PGDATABASE}"
export SERVER_URL API_KEY APP_KEY PGDATABASE
fail=0
for check in downloads-artifacts onboarding-snippet onboarding-snippet-node onboarding-snippet-otlp onboarding-agent-compose onboarding-dd-compat installer-clean-deploy; do
  echo "=== $check"
  if "$DIR/$check.sh"; then :; else fail=1; echo "=== $check FAILED"; fi
done
[ "$fail" = 0 ] && echo "=== ALL REGRESSION CHECKS PASSED" || echo "=== REGRESSION FAILURES PRESENT"
exit "$fail"
