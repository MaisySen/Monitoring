#!/usr/bin/env bash
# Restore a Monitoring backup into an EMPTY database.
#   DATABASE_URL=postgres://user@host:5432/monitoring ./scripts/restore.sh <dump-file>
# The target database must already exist and be empty (createdb first). Migrations run
# on the next server start and no-op against a restored schema of the same version.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to the Monitoring database}"
DUMP="${1:?usage: restore.sh <dump-file>}"
[ -f "$DUMP" ] || { echo "not found: $DUMP" >&2; exit 1; }
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" "$DUMP"
echo "restored $DUMP into $DATABASE_URL"
