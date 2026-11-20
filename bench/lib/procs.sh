#!/usr/bin/env bash
# Ownership-scoped process management for bench/regression work.
#
# Rule: never kill by port, name pattern, or ss/pgrep lookup. Those match
# processes owned by other tests, servers, or the platform (a broad
# port-cleanup kill once took down the local Postgres mid-session).
# Instead: record what YOU started, and stop only that.
#
#   own_start NAME CMD [ARGS...]   launch detached, record pid + start tick
#   own_stop NAME                  kill only the recorded pid, and only if its
#                                  /proc start tick still matches (pid reuse safe)
#   own_stop_all                   stop every recorded name
#
# OWN_DIR defaults to /tmp/monitoring-owned; set it per-run for isolation.
OWN_DIR="${OWN_DIR:-/tmp/monitoring-owned}"

own_start() {
  local name="$1"; shift
  mkdir -p "$OWN_DIR"
  setsid nohup "$@" > "$OWN_DIR/$name.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$OWN_DIR/$name.pid"
  awk '{print $22}' "/proc/$pid/stat" 2>/dev/null > "$OWN_DIR/$name.tick" || true
  echo "$pid"
}

own_stop() {
  local name="$1"
  local pidfile="$OWN_DIR/$name.pid" tickfile="$OWN_DIR/$name.tick"
  [ -f "$pidfile" ] || return 0
  local pid; pid=$(cat "$pidfile")
  if [ -d "/proc/$pid" ]; then
    local recorded current
    recorded=$(cat "$tickfile" 2>/dev/null)
    current=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null)
    if [ -z "$recorded" ] || [ "$recorded" = "$current" ]; then
      kill "$pid" 2>/dev/null || true
    else
      echo "own_stop: pid $pid reused by another process, not killing" >&2
    fi
  fi
  rm -f "$pidfile" "$tickfile"
}

own_stop_all() {
  local f
  for f in "$OWN_DIR"/*.pid; do
    [ -e "$f" ] || continue
    own_stop "$(basename "$f" .pid)"
  done
}
