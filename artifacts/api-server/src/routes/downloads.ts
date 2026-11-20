import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOrigin } from "../lib/config";

/**
 * Monitoring Agent and library downloads, plus the one-line agent installer.
 *   GET /downloads/<file>    files from MONITORING_DOWNLOADS_DIR (default: <api-server>/downloads)
 *   GET /install.sh          shell installer; reads MONITORING_API_KEY (and optional MONITORING_ENV, MONITORING_HOSTNAME) from the environment
 */
const router: IRouter = Router();
const DIR = process.env.MONITORING_DOWNLOADS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../downloads");

router.get("/downloads", (_req, res) => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => !f.startsWith(".")) : [];
  res.json({ files: files.map((f) => ({ name: f, bytes: fs.statSync(path.join(DIR, f)).size, url: `/downloads/${f}` })) });
});

router.get("/downloads/:file", (req, res) => {
  const f = path.basename(String(req.params.file));
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.download(p, f);
});

// SHA-256 of the agent binaries this server hosts, computed here (cached by size and mtime) and written into the
// installer, so the installer does not trust a checksum file fetched from the same place as the binary.
const hashCache = new Map<string, { key: string; sha: string }>();
function agentHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(DIR)) return out;
  for (const f of fs.readdirSync(DIR)) {
    if (!/^monitoring-agent-(linux|darwin)-(amd64|arm64)$/.test(f)) continue;
    const st = fs.statSync(path.join(DIR, f));
    const key = `${st.size}:${st.mtimeMs}`;
    let c = hashCache.get(f);
    if (!c || c.key !== key) {
      c = {
        key,
        sha: crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(DIR, f)))
          .digest("hex"),
      };
      hashCache.set(f, c);
    }
    out[f] = c.sha;
  }
  return out;
}

router.get("/install.sh", (req, res) => {
  const url = getOrigin(req);
  const quotedUrl = "'" + url.replace(/'/g, "'\\''") + "'";
  const downloadUrl = process.env.MONITORING_DOWNLOAD_URL ?? `${url}/downloads`;
  const quotedDownloads = "'" + downloadUrl.replace(/'/g, "'\\''") + "'";
  const hashes = process.env.MONITORING_DOWNLOAD_URL ? {} : agentHashes();
  const hashLines = Object.entries(hashes)
    .map(([f, h]) => `  ${f}) EXPECTED=${h} ;;`)
    .join("\n");
  res.type("text/x-shellscript").send(`#!/bin/sh
# Monitoring Agent installer: curl -fsSL ${url}/install.sh | MONITORING_API_KEY=<key> sh
set -e
URL=\${MONITORING_URL:-${quotedUrl}}
DOWNLOAD_URL=\${MONITORING_DOWNLOAD_URL:-${quotedDownloads}}
[ -n "$MONITORING_API_KEY" ] || { echo "Set MONITORING_API_KEY (Organization Settings -> API Keys)"; exit 1; }
ARCH=$(uname -m); case "$ARCH" in x86_64|amd64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; *) echo "Unsupported architecture: $ARCH"; exit 1;; esac
OS=$(uname -s | tr A-Z a-z)
case "$OS" in linux|darwin) ;; *) echo "Unsupported OS: $OS"; exit 1;; esac
SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
FILE="monitoring-agent-$OS-$ARCH"
echo "Downloading Monitoring Agent ($OS/$ARCH) ..."
# Expected checksum, in order of trust: MONITORING_AGENT_SHA256 (pinned by you), the checksum this server computed for
# the binary it hosts, or SHA256SUMS next to the binary (only when the download source differs from this server).
EXPECTED=\${MONITORING_AGENT_SHA256:-}
if [ -z "$EXPECTED" ]; then
  case "$FILE" in
${hashLines}
  *) ;;
  esac
fi
case "$DOWNLOAD_URL" in
  https://*|"$URL"/*) ;;
  *) [ -n "$EXPECTED" ] || { echo "Refusing to download over plain HTTP from another host without MONITORING_AGENT_SHA256"; exit 1; } ;;
esac
curl -fsSL "$DOWNLOAD_URL/$FILE" -o "$TMP/$FILE"
if [ -z "$EXPECTED" ]; then
  curl -fsSL "$DOWNLOAD_URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
  EXPECTED=$(grep "  $FILE$" "$TMP/SHA256SUMS" | cut -d" " -f1)
fi
[ -n "$EXPECTED" ] || { echo "No checksum available for $FILE"; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP/$FILE" | cut -d" " -f1)
elif command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$TMP/$FILE" | cut -d" " -f1)
else echo "Install sha256sum or shasum to verify the download"; exit 1; fi
[ "$ACTUAL" = "$EXPECTED" ] || { echo "Checksum mismatch for $FILE: expected $EXPECTED, got $ACTUAL"; exit 1; }
# Releases built by this project's GitHub workflow carry a signed build attestation. With the GitHub CLI installed,
# MONITORING_VERIFY_REPO=<owner>/<repo> checks it before installing.
if [ -n "\${MONITORING_VERIFY_REPO:-}" ]; then
  command -v gh >/dev/null 2>&1 || { echo "MONITORING_VERIFY_REPO is set but the GitHub CLI (gh) is not installed"; exit 1; }
  gh attestation verify "$TMP/$FILE" --repo "$MONITORING_VERIFY_REPO" >/dev/null || { echo "Attestation check failed for $FILE"; exit 1; }
  echo "Verified build attestation from $MONITORING_VERIFY_REPO."
fi
$SUDO mkdir -p /opt/monitoring-agent/bin /etc/monitoring
$SUDO install -m 0755 "$TMP/$FILE" /opt/monitoring-agent/bin/monitoring-agent
curl -fsSL "$DOWNLOAD_URL/monitoring-agent-THIRD_PARTY_NOTICES.txt" -o "$TMP/NOTICES" 2>/dev/null && $SUDO install -m 0644 "$TMP/NOTICES" /opt/monitoring-agent/THIRD_PARTY_NOTICES.txt || true
if [ ! -f /etc/monitoring/monitoring.yaml ]; then
  $SUDO touch /etc/monitoring/monitoring.yaml
  $SUDO chmod 0600 /etc/monitoring/monitoring.yaml
  $SUDO tee /etc/monitoring/monitoring.yaml >/dev/null <<CFG
api_key: $MONITORING_API_KEY
url: $URL
\${MONITORING_HOSTNAME:+hostname: $MONITORING_HOSTNAME}
env: \${MONITORING_ENV:-prod}
tags: []
host_metrics:
  enabled: true
  interval: 15s
apm:
  otlp: true
  datadog_compat: true
dogstatsd:
  enabled: true
  port: 8125
logs: []
CFG
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  $SUDO tee /etc/systemd/system/monitoring-agent.service >/dev/null <<UNIT
[Unit]
Description=Monitoring Agent
After=network-online.target
[Service]
ExecStart=/opt/monitoring-agent/bin/monitoring-agent run -c /etc/monitoring/monitoring.yaml
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload && $SUDO systemctl enable --now monitoring-agent
  echo "Monitoring Agent installed and running (systemctl status monitoring-agent)."
else
  echo "Installed. Start it with: /opt/monitoring-agent/bin/monitoring-agent run -c /etc/monitoring/monitoring.yaml"
fi
`);
});

export default router;
