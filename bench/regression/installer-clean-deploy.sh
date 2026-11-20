#!/usr/bin/env bash
# Clean-deployment validation: prove a fresh artifact set packs reproducibly
# and installs through the PUBLISHED installer (install.sh as served by the
# server), with provenance verified end to end.
#
# Steps:
#   1. Wipe the server's downloads dir (backed up first), run scripts/pack-sdks.mjs.
#   2. Verify the served artifact set (downloads-artifacts.sh).
#   3. Run the published install.sh verbatim (MONITORING_PREFIX relocates
#      /opt//etc into a scratch root; the install path is otherwise unchanged).
#   4. Assert the installed binary is an ELF whose sha256 matches the served
#      SHA256SUMS, the config is 0600 with the key, and the binary executes.
#   5. Negative controls: pack must FAIL CLOSED when SHA256SUMS is missing and
#      when a binary is tampered (both restored afterwards).
#
# Usage: SERVER_URL=http://127.0.0.1:4731 API_KEY=... bench/regression/installer-clean-deploy.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${SERVER_URL:?set SERVER_URL}" "${API_KEY:?set API_KEY}"
DL="$ROOT/artifacts/api-server/downloads"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; rm -rf /tmp/monitoring-prefix-test' EXIT

fail=0
step() { echo "== $*"; }

step "1. clean pack from a wiped downloads dir"
mkdir -p "$DL"
cp -a "$DL" "$WORK/downloads.bak"
rm -rf "$DL"
if ! node "$ROOT/scripts/pack-sdks.mjs" > "$WORK/pack.log" 2>&1; then
  echo "FAIL: pack-sdks.mjs failed on a clean tree:"; tail -5 "$WORK/pack.log"
  rm -rf "$DL"; mv "$WORK/downloads.bak" "$DL"; exit 1
fi
grep -c 'sha256 verified' "$WORK/pack.log" | xargs echo "verified binaries packed:"

step "2. served artifact set integrity"
SERVER_URL="$SERVER_URL" "$ROOT/bench/regression/downloads-artifacts.sh" || fail=1
curl -fsS "$SERVER_URL/downloads/SHA256SUMS" -o "$WORK/SHA256SUMS" || { echo "FAIL: SHA256SUMS not served"; fail=1; }

step "3. published installer, verbatim (prefix-relocated)"
rm -rf /tmp/monitoring-prefix-test
curl -fsSL "$SERVER_URL/install.sh" -o "$WORK/install.sh"
if MONITORING_PREFIX=/tmp/monitoring-prefix-test MONITORING_API_KEY="$API_KEY" MONITORING_URL="$SERVER_URL" sh "$WORK/install.sh" > "$WORK/install.log" 2>&1; then
  echo "installer completed"
else
  echo "FAIL: installer exited nonzero:"; tail -8 "$WORK/install.log"; fail=1
fi

step "4. installed-artifact assertions"
BIN=/tmp/monitoring-prefix-test/opt/monitoring-agent/bin/monitoring-agent
CFG=/tmp/monitoring-prefix-test/etc/monitoring/monitoring.yaml
[ -f "$BIN" ] || { echo "FAIL: installed binary missing"; fail=1; }
[ "$(od -A n -t x1 -N 4 "$BIN" 2>/dev/null | tr -d ' \n')" = "7f454c46" ] || { echo "FAIL: installed binary is not ELF"; fail=1; }
EXPECTED=$(grep '  monitoring-agent-linux-amd64$' "$WORK/SHA256SUMS" | cut -d' ' -f1)
ACTUAL=$(sha256sum "$BIN" | cut -d' ' -f1)
[ "$ACTUAL" = "$EXPECTED" ] || { echo "FAIL: installed binary sha256 != served SHA256SUMS"; fail=1; }
[ "$(stat -c %a "$CFG")" = "600" ] || { echo "FAIL: config mode $(stat -c %a "$CFG"), want 600"; fail=1; }
grep -q "api_key: $API_KEY" "$CFG" || { echo "FAIL: config missing api_key"; fail=1; }
"$BIN" --help > /dev/null 2>&1 || "$BIN" -h > /dev/null 2>&1 || { echo "FAIL: installed binary does not execute"; fail=1; }
[ "$fail" = 0 ] && echo "installed binary: ELF, sha256 matches served SHA256SUMS, config 0600, executes"

step "5. negative controls: pack fails closed"
mv "$ROOT/agent/dist/SHA256SUMS" "$WORK/SHA256SUMS.hide"
if node "$ROOT/scripts/pack-sdks.mjs" > /dev/null 2>&1; then
  echo "FAIL: pack succeeded without SHA256SUMS (must fail closed)"; fail=1
else
  echo "PASS: pack refuses to run without SHA256SUMS"
fi
mv "$WORK/SHA256SUMS.hide" "$ROOT/agent/dist/SHA256SUMS"
B="$ROOT/agent/dist/monitoring-agent-linux-amd64"
cp "$B" "$WORK/binary.bak"; printf 'x' >> "$B"
if node "$ROOT/scripts/pack-sdks.mjs" > /dev/null 2>&1; then
  echo "FAIL: pack succeeded with a tampered binary (must fail closed)"; fail=1
else
  echo "PASS: pack refuses a tampered binary (checksum mismatch)"
fi
mv "$WORK/binary.bak" "$B"

# leave the server's downloads as the freshly packed clean set; remove backup
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || echo "FAILURES PRESENT"
exit "$fail"
