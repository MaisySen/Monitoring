#!/usr/bin/env bash
# Regression check: run the PUBLISHED Python onboarding snippet verbatim and
# assert spans actually arrive.
#
# Origin: 2026-11-21 incident - the published snippet ended with plain
# `python app.py`; it installed deps but never activated auto-instrumentation,
# so a user following the instructions got a working app and zero telemetry.
# Guide/demo commands elsewhere used the correct form and masked the defect.
# This check extracts the snippet from the web source (the same template the
# Connect page renders), substitutes only the URL/key placeholders, and runs
# it verbatim in a fresh venv. It fails if no spans land.
#
# Usage:
#   SERVER_URL=http://127.0.0.1:4731 API_KEY=... PGDATABASE=valrun \
#   bench/regression/onboarding-snippet.sh
# Optional: PGHOST PGPORT PGUSER (defaults 127.0.0.1 5433 monitoring), APP_PORT (4932).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${SERVER_URL:?set SERVER_URL}" "${API_KEY:?set API_KEY}" "${PGDATABASE:?set PGDATABASE}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5433}" PGUSER="${PGUSER:-monitoring}"
APP_PORT="${APP_PORT:-4932}"
command -v psql >/dev/null || export PATH="$HOME/pgsql/usr/lib/postgresql/14/bin:$PATH"

WORK="$(mktemp -d)"
cleanup() { [ -f "$WORK/app.pid" ] && kill "$(cat "$WORK/app.pid")" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# 1. Extract the published snippet(s) from the source the UI renders.
python3 - "$ROOT/artifacts/web/src/pages/Misc.tsx" "$WORK" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
snips = re.findall(r"python:\s*`([^`]*)`", src)
if not snips:
    sys.exit("FAIL: no python snippet found in published source")
for i, s in enumerate(snips):
    s = re.sub(r"\$\{(URL|url)\}", "@@URL@@", s)
    s = re.sub(r"\$\{(KEY|key)\}", "@@KEY@@", s)
    pathlib.Path(sys.argv[2], f"snippet-{i}.sh").write_text(s + "\n")
print(f"extracted {len(snips)} published python snippet(s)")
PY

# 2. Minimal user app (the snippet instruments the user's own app; we supply one).
mkdir -p "$WORK/app"
cat > "$WORK/app/app.py" <<PY
from flask import Flask
app = Flask(__name__)

@app.route("/ok")
def ok():
    return "ok"

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=$APP_PORT)
PY

fail=0
for snip in "$WORK"/snippet-*.sh; do
  name="$(basename "$snip" .sh)"
  sed -e "s|@@URL@@|$SERVER_URL|g" -e "s|@@KEY@@|$API_KEY|g" "$snip" > "$WORK/$name.run.sh"
  before=$(psql -d "$PGDATABASE" -t -A -c "select count(*) from spans where service='my-app'")

  venv="$WORK/venv-$name"
  python3 -m venv "$venv"
  "$venv/bin/pip" install -q flask   # the user app's own dependency
  # Verbatim snippet: setup lines, then the env-prefixed run line, split at the
  # first MONITORING_URL= line. Text is executed unchanged.
  awk -v run="$WORK/$name.runpart.sh" '
    /^MONITORING_URL=/ {inrun=1}
    inrun {print > run; next}
    {print}
  ' "$WORK/$name.run.sh" > "$WORK/$name.setup.sh"
  ( cd "$WORK/app" && env PATH="$venv/bin:/usr/bin:/bin" bash "$WORK/$name.setup.sh" ) > "$WORK/$name.install.log" 2>&1
  ( cd "$WORK/app" && env PATH="$venv/bin:/usr/bin:/bin" setsid nohup bash "$WORK/$name.runpart.sh" > "$WORK/$name.app.log" 2>&1 & echo $! > "$WORK/app.pid" )

  ok=""
  for _ in $(seq 1 15); do
    sleep 1
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/ok" || true)" = "200" ] && { ok=1; break; }
  done
  [ -n "$ok" ] || { echo "FAIL [$name]: app did not answer on :$APP_PORT"; fail=1; continue; }
  sleep 8   # allow span flush
  after=$(psql -d "$PGDATABASE" -t -A -c "select count(*) from spans where service='my-app'")
  kill "$(cat "$WORK/app.pid")" 2>/dev/null || true; rm -f "$WORK/app.pid"; sleep 1
  if [ "$after" -gt "$before" ]; then
    echo "PASS [$name]: spans $before -> $after (verbatim published snippet produced telemetry)"
  else
    echo "FAIL [$name]: spans $before -> $after (published snippet produced NO telemetry)"
    fail=1
  fi
done
exit "$fail"
