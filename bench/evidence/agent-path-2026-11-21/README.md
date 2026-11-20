# Agent install path incident + verification (2026-11-21)

Defect found: the served monitoring-agent-linux-amd64 in the api-server downloads
dir was a 100,000-byte random-data placeholder. The published install.sh would
have downloaded it, passed its own SHA-256 check (the hash endpoint hashes the
same served file), installed it, and the agent would fail to exec - a user
following the published Docs "with agent" path got a broken install.

Fix: real CI-built binaries (run 44710994706, artifact 14618621071), SHA256SUMS
verified locally (artifact-sha256sums-verify.log), installed into the downloads
dir (gitignored; deployments must pack them - see downloads-artifacts.sh).

Live verification of the full published "with agent" path:
- Agent run with example-derived config (api_key/url/listen 127.0.0.1, host_metrics off): OTLP receivers on 4317/4318 (agent-run.log).
- Verbatim Docs run line, NO MONITORING_URL/MONITORING_API_KEY: MONITORING_SERVICE=checkout MONITORING_ENV=prod MONITORING_VERSION=1.0.0 node -r @monitoring/trace/init app.js (SDK default http://localhost:4318).
- Span landed via agent forward: service=checkout (spans=1), service_versions recorded version 1.0.0 env prod (span-query.txt).

Regression: bench/regression/downloads-artifacts.sh (presence + minimum size +
magic bytes for every hosted artifact). The placeholder (100,000 bytes, not ELF)
fails both the size and magic checks.
