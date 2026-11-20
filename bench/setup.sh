#!/bin/bash
# Installs what the correctness, resilience and incident tests need into bench/.deps (override with BENCH_DEPS):
#   node/   the Monitoring Node library (from sdks/node) and the test apps' dependencies
#   venv/   a Python venv with the Monitoring Python library (from sdks/python) and the test apps' dependencies
# Needs Node 22+ and Python 3.10+.
set -euo pipefail
cd "$(dirname "$0")/.."
DEPS=${BENCH_DEPS:-bench/.deps}
mkdir -p "$DEPS/node"
( cd sdks/node && npm ci --silent )
TGZ=$(cd sdks/node && npm pack --silent --pack-destination "$OLDPWD/$DEPS")
( cd "$DEPS/node" && { [ -f package.json ] || npm init -y >/dev/null; } \
  && npm install --silent --no-audit --no-fund "../$TGZ" express@5.3.0 pg@8.23.1 winston@3.19.0 )
python3 -m venv "$DEPS/venv"
"$DEPS/venv/bin/pip" install -q -e 'sdks/python[instrumentation]' flask==3.1.3 requests==2.34.2
"$DEPS/venv/bin/monitoring-bootstrap" -a install >/dev/null
echo "benchmark dependencies installed in $DEPS"
