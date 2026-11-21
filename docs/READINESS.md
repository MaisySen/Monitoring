# Monitoring — readiness inventory (2026-11-21)

What is verified, what is not, and what is held. Every "verified" line has
evidence in this repo (bench/evidence/, docs/ENGINEERING_STATE.md) or was run
live against a local server. This file distinguishes measured facts from
workflow state and never upgrades one into the other.

## Product journey (P0/P1/P2 shipped)

- P0: onboarding with live data detection, Now page, auto default monitors,
  service health summary. Validated end-to-end: empty account to first useful
  answer in 190s scripted (evidence bench/evidence/validation-2026-11-21/).
- P1: exception grouping + error pages; env-scoped version-first-observed
  timing ("observed before first sighting"). True deploy markers are NOT built
  and are never claimed (they need separately recorded deployment evidence).
- P2: uptime checks; problem acknowledge/resolve/reopen. Multies-native
  delivery (chat/task/mail) is HELD — needs Multies-side bridge authority.
- Unit suite 110/110. CI (Build checks, develop): green on every pushed
  commit. A live-regression CI job runs the full verbatim suite against a
  server booted from each commit (green since 742d356).
- Bounded soak (8 min, agent-compose path, current build): 948/948 spans,
  98/98 errors, zero duplicates (details in ENGINEERING_STATE).

## Published-surface coverage (every copyable command verbatim-tested)

bench/regression/run-all.sh — 7 checks, ALL PASS against a live server
(isolated "regression" org on the e2e instance; never the demo org):

1. onboarding-snippet.sh — published Python snippet extracted from the UI
   source, run verbatim; spans land. (Incident 2026-11-21: the published run
   line was plain `python app.py` and produced zero telemetry; fixed to
   `monitoring-run python app.py`; failed path preserved in
   bench/evidence/onboarding-snippet-2026-11-21/.)
2. onboarding-snippet-node.sh — published Node snippet, verbatim.
3. onboarding-snippet-otlp.sh — published OTLP endpoint/header with a raw
   hand-encoded protobuf payload. (Harness note: fresh trace ids per run;
   intake is idempotent per (org, trace_id, span_id).)
4. onboarding-agent-compose.sh — published "with a local agent" path, no
   MONITORING_URL/KEY; SDK -> localhost:4318 -> agent -> server.
5. onboarding-dd-compat.sh — the 4 published Datadog-compat curl commands
   (v2/series, v2/logs, v1/events, v1/monitor) + wrong-app-key negative.
6. downloads-artifacts.sh — every hosted artifact present, minimum size,
   magic bytes (guards the 2026-11-21 placeholder incident: a 100KB random
   file was served as the agent binary).
7. installer-clean-deploy.sh — clean pack from a wiped downloads dir, then
   the published install.sh verbatim into a scratch prefix; installed binary
   is ELF whose sha256 matches the served SHA256SUMS; config 0600; binary
   executes; pack fails closed without SHA256SUMS or with a tampered binary.

## Build/release chain (reproducible, no manual steps)

- scripts/fetch-agent-dist.mjs pulls the agent artifact from the latest
  successful Build checks run (pin with MONITORING_AGENT_RUN_ID), verifies
  all checksums, validates per-platform magic and executable bits, records
  provenance in agent/dist/PROVENANCE.json. Fails closed.
- scripts/pack-sdks.mjs packs Node tgz + Python wheel from source and copies
  agent binaries only after sha256 verification against agent/dist/SHA256SUMS;
  fails closed on any mismatch. (python3 -m build 1.6.1 available locally.)
- SHA256SUMS matching establishes internal consistency; origin is the
  recorded CI run/artifact. Install-time attestation check is available via
  MONITORING_VERIFY_REPO in the served install.sh.

## Unverified (recorded, not claimed)

- Default privileged/systemd install path: prefix-relocated validation covers
  download/checksum/install/config but NOT root install or systemd unit
  registration. No systemd exists in this environment. Verify in a disposable
  systemd VM/container before claiming it.
- Local Go build of the agent: blocked by this box's RAM (known). CI builds;
  distribution uses the fetch script.
- Long-run soak beyond bounded runs: this sandbox restarts between agent
  runs (observed twice on 2026-11-21), killing background processes, so a
  continuous multi-hour soak is not achievable here. Bounded evidence:
  15-min soak at 400 traces/s (99.94% stored, gap fully explained by 6
  generator-recorded ECONNRESETs) and a ramp finding 800 traces/s as this
  box's breaking point. Not weeks of operation.

## Held (authority)

- Multies-native delivery (Beat 4): needs Multies-side bridge authority.
- External webhook telemetry: no authority granted; probes stay local.
- Multies repository and Fintex runbook: read-only.

## Demo state

- valrun instance (:4731, org "Fresh Shop") is demo-ready: only the shop-api
  validation story (ValueError incident with version chip, versions 1.0.0/1.1.0,
  3 story events). Verified by screenshot after cleaning regression pollution.
- Regression checks run ONLY against the e2e instance (:4730, org "regression").
