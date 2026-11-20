#!/usr/bin/env bash
# Back up a Monitoring Postgres database to a compressed custom-format dump.
#   DATABASE_URL=postgres://user@host:5432/monitoring ./scripts/backup.sh [output-file]
# Default output: ./monitoring-backup-YYYYMMDD-HHMMSS.dump
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to the Monitoring database}"
OUT="${1:-monitoring-backup-$(date +%Y%m%d-%H%M%S).dump}"
pg_dump --format=custom --compress=6 --no-owner --no-privileges \
  --file="$OUT" "$DATABASE_URL"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
