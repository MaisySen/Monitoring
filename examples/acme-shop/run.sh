#!/bin/bash
# Acme Shop on the Monitoring stack: five services instrumented with the Monitoring libraries, sending to Monitoring directly
# (MONITORING_URL + MONITORING_API_KEY) or to a local Monitoring Agent (leave MONITORING_URL unset). See README.md for setup.
set -e
cd "$(dirname "$0")"
export ACME_DATABASE_URL=${ACME_DATABASE_URL:-postgresql://localhost/shop}
export ACME_LOG_DIR=${ACME_LOG_DIR:-/tmp/acme-shop}
mkdir -p "$ACME_LOG_DIR"
PY=${ACME_PYTHON:-.venv/bin}
export MONITORING_ENV=${MONITORING_ENV:-prod} MONITORING_TAGS=${MONITORING_TAGS:-team:acme}
psql "$ACME_DATABASE_URL" -q -c "create table if not exists carts (id bigserial primary key, user_id int not null, sku text not null, qty int not null);
  create table if not exists orders (id bigserial primary key, user_id int not null, total_cents int not null, status text not null);"
trap 'kill 0' EXIT
MONITORING_SERVICE=web-gateway MONITORING_VERSION=2.5.0 node -r @monitoring/trace/init gateway/app.js &
# cart-service runs under a restart loop that reads its version from /tmp/acme-cart-version (what a deploy system does);
# bench/incident/inject.sh deploy-bad|rollback "deploys" a new version by writing the file and restarting the process.
(while true; do MONITORING_SERVICE=cart-service MONITORING_VERSION=$(cat /tmp/acme-cart-version 2>/dev/null || echo 2.0.0) node -r @monitoring/trace/init cart/app.js; sleep 0.5; done) &
MONITORING_SERVICE=payments-service MONITORING_VERSION=3.2.0 node -r @monitoring/trace/init payments/app.js &
MONITORING_SERVICE=catalog-service MONITORING_VERSION=1.3.0 $PY/monitoring-run $PY/python catalog/app.py &
sleep 5
MONITORING_SERVICE=order-worker MONITORING_VERSION=0.9.0 $PY/monitoring-run $PY/python worker/worker.py &
node traffic.js &
wait
