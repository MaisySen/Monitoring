#!/usr/bin/env bash
# Regression check: every artifact the server hosts in /downloads must be the
# real thing, not a placeholder. Origin: 2026-11-21 - the served
# monitoring-agent-linux-amd64 was 100,000 bytes of random data; the published
# install.sh would have installed it successfully (hash endpoint hashes the
# same file) and the agent would fail to exec.
#
# Checks: file presence, minimum size, and magic bytes
# (ELF for agent binaries, gzip for .tgz, PK zip for .whl).
#
# Usage: SERVER_URL=http://127.0.0.1:4731 bench/regression/downloads-artifacts.sh
set -euo pipefail
: "${SERVER_URL:?set SERVER_URL}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

fail=0
check() { # name min_bytes magic_hex
  local name="$1" min="$2" magic="$3"
  if ! curl -fsS "$SERVER_URL/downloads/$name" -o "$WORK/$name"; then
    echo "FAIL [$name]: not downloadable"; fail=1; return
  fi
  local size head
  size=$(stat -c %s "$WORK/$name")
  head=$(od -A n -t x1 -N 4 "$WORK/$name" | tr -d ' \n')
  if [ "$size" -lt "$min" ]; then
    echo "FAIL [$name]: $size bytes (< $min, placeholder size)"; fail=1; return
  fi
  case "$head" in
    "$magic"*) echo "PASS [$name]: $size bytes, magic ok" ;;
    *) echo "FAIL [$name]: magic $head (want $magic*)"; fail=1 ;;
  esac
}

check monitoring-agent-linux-amd64 10000000 7f454c46     # ELF, real agent > 10 MB
check monitoring-trace-0.1.0.tgz    1000    1f8b         # gzip
check monitoring_trace-0.1.0-py3-none-any.whl 1000 504b0304  # zip
exit "$fail"
