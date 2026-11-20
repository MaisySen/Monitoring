#!/usr/bin/env bash
# Regression check: exercise the PUBLISHED "any OTLP" onboarding snippet's
# endpoint + header contract verbatim and assert a span actually lands.
# The snippet is configuration for the user's existing OpenTelemetry SDK:
#   OTEL_EXPORTER_OTLP_ENDPOINT=${URL}/otlp
#   OTEL_EXPORTER_OTLP_HEADERS=DC-API-KEY=${KEY}
#   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# This check extracts those values from the published source, hand-encodes a
# minimal OTLP/HTTP protobuf ExportTraceServiceRequest (stdlib only), posts it
# to the published endpoint with the published header, and asserts the span
# arrives in storage under the resource's service.name.
#
# Usage:
#   SERVER_URL=http://127.0.0.1:4731 API_KEY=... PGDATABASE=valrun \
#   bench/regression/onboarding-snippet-otlp.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${SERVER_URL:?set SERVER_URL}" "${API_KEY:?set API_KEY}" "${PGDATABASE:?set PGDATABASE}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5433}" PGUSER="${PGUSER:-monitoring}"
command -v psql >/dev/null || export PATH="$HOME/pgsql/usr/lib/postgresql/14/bin:$PATH"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# 1. Extract the published otlp snippet and take its endpoint/header verbatim.
python3 - "$ROOT/artifacts/web/src/pages/Misc.tsx" "$SERVER_URL" "$API_KEY" "$WORK" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
snips = re.findall(r"otlp:\s*`([^`]*)`", src)
if not snips:
    sys.exit("FAIL: no otlp snippet found in published source")
s = snips[0]
endpoint = re.search(r"OTEL_EXPORTER_OTLP_ENDPOINT=(\S+)", s).group(1)
endpoint = re.sub(r"\$\{(URL|url)\}", sys.argv[2], endpoint)
header = re.search(r"OTEL_EXPORTER_OTLP_HEADERS=(\S+)", s).group(1)
header = re.sub(r"\$\{(KEY|key)\}", sys.argv[3], header)
pathlib.Path(sys.argv[4], "otlp.env").write_text(endpoint + "\n" + header + "\n")
print(f"published endpoint: {endpoint}")
print(f"published header name: {header.split('=')[0]}")
PY
read -r ENDPOINT < "$WORK/otlp.env"
HEADER="$(sed -n 2p "$WORK/otlp.env" | sed 's/=/: /')"  # OTel env form Name=Value -> HTTP Name: Value

# 2. Hand-encode a minimal ExportTraceServiceRequest (protobuf, stdlib only).
python3 - "$WORK/payload.bin" <<'PY'
import sys, time, os
def varint(n):
    out = b""
    while True:
        b = n & 0x7F; n >>= 7
        out += bytes([b | 0x80]) if n else bytes([b])
        if not n: return out
def field(num, wt): return varint(num << 3 | wt)
def msg(num, body): return field(num, 2) + varint(len(body)) + body
def s(num, v): return msg(num, v.encode())
def f64(num, v): return field(num, 1) + int(v).to_bytes(8, "little")

kv = lambda k, v: msg(1, s(1, k) + msg(2, s(1, v)))           # KeyValue{key, AnyValue{string_value}}
resource = msg(1, kv("service.name", "otlp-snippet-test"))      # Resource{attributes}
now = time.time_ns()
tid, sid = os.urandom(16), os.urandom(8)   # fresh ids per run: intake dedupes (org, trace_id, span_id)
span = (msg(1, tid) + msg(2, sid)                                # trace_id, span_id
        + s(3, "otlp-snippet-op")                               # name
        + f64(7, now - 1_000_000) + f64(8, now))                # start/end unix nanos
scope_spans = msg(2, msg(2, span))                              # ScopeSpans{spans}
resource_spans = msg(1, resource + scope_spans)                 # ResourceSpans
open(sys.argv[1], "wb").write(resource_spans)
PY

# 3. POST to the published endpoint with the published header; assert storage.
before=$(psql -d "$PGDATABASE" -t -A -c "select count(*) from spans where service='otlp-snippet-test'")
code=$(curl -s -o "$WORK/resp.bin" -w '%{http_code}' -X POST "$ENDPOINT/v1/traces" \
  -H "Content-Type: application/x-protobuf" -H "$HEADER" --data-binary @"$WORK/payload.bin")
[ "$code" = "200" ] || { echo "FAIL: published endpoint returned $code"; exit 1; }
sleep 3
after=$(psql -d "$PGDATABASE" -t -A -c "select count(*) from spans where service='otlp-snippet-test'")
if [ "$after" -gt "$before" ]; then
  echo "PASS: spans $before -> $after (published OTLP endpoint/header accepted a raw OTLP SDK payload)"
else
  echo "FAIL: spans $before -> $after (published OTLP config produced NO telemetry)"; exit 1
fi
