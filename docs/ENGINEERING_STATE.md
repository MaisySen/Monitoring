# Engineering state (2026-11-20)

Working copy of the Monitoring feature build. Local only: not published anywhere; Multies repo untouched.

## Done and proven (each on the production build against PostgreSQL 14)
- M1 rebrand to "Monitoring" (legal NOTICE/attribution kept; MODIFICATIONS.md added). 60/60 unit tests, SDK suites.
- M2 multi-org membership: org_memberships + migration 4 backfill, org switcher, roles, invites for existing
  accounts, last-admin guard. bench/security/memberships.js 30/30; isolation.js 13/13; scripts/e2e.sh correct.
- M3 per-org quotas: org_quotas/org_usage_daily (migration 5), enforcement at intake (points/logs/spans per day,
  series cap, per-minute bytes), GET/PUT /api/ui/org/quotas, Usage & Limits UI tab. bench/security/quotas.js 21/21;
  memberships 30/30 + isolation 13/13 + e2e re-run green after quota changes.

## Local environment
- Rootless PostgreSQL 14.24: ~/pgsql (binaries), ~/pgdata (cluster), port 5433, user monitoring.
  Start: PATH=$HOME/pgsql/usr/lib/postgresql/14/bin:$PATH pg_ctl -D ~/pgdata -l ~/pg.log -o "-k /tmp -p 5433 -c listen_addresses='127.0.0.1'" start
- Server: build with `pnpm run build:selfhost`, run dist/index.mjs with NODE_ENV=production PUBLIC_URL PORT
  DATABASE_URL MONITORING_SETUP_TOKEN SESSION_SECRET. Use setsid+nohup so it survives the shell.
- Test DBs: memtest (memberships), qtest* (quotas), e2e (e2e.sh + isolation.js). Recreate fresh before each run
  (setup is first-run only).

## Remaining (planned milestones 4-6)
- M4 end-to-end demo: scripted journey + UI screenshots (org switcher, usage tab, dashboards, alerts firing).
- M5 hardening: pnpm audit, backup/restore script + restore test, isolation suite adapted to multi-membership
  (a user in two orgs must still see only the active org's data — partially covered by memberships.js).
- M6 readiness report: tested vs untested limits (concurrency, storage scale, ClickHouse path, Go agent build,
  Multies sign-in bridge pending Multies repo access, hosting/deployment pending approval).

## 2026-11-20 18:00 update (post quota-rework)
- Quota contract rework complete: 429 daily refusals, OTLP partial_success series cap, shared PG enforcement (org_usage_daily + org_usage_minute atomic upserts), series cap under advisory lock, oversize batch refused+charged, limit cache TTL 2s. quotas.js 34/34 two-process. Commits 54c5104, 7da6eef.
- Logo: CatMark replaced with MonitoringMark (pulse), favicon too. Commit c876ef7.
- bench/alerting-journey.js: 14/14 (dashboard, webhook channel, monitor trigger/recovery + deliveries). Needs MONITORING_ALLOW_PRIVATE_WEBHOOKS=true on the server for loopback sink; metric monitors read closed minute buckets only (wait for boundary before evaluate). Commit 509c55f.
- pnpm audit clean (prod + full). scripts/backup.sh + scripts/restore.sh committed; RESTORE TEST RUN 2026-11-21 01:00: PASS, full-DB pg_dump->pg_restore on recagent (915,675 spans, 499,686 logs, 23 tables) with exact count equality + spot checks; scope and reconciliation note in bench/evidence/restore-test-2026-11-21.json.
- NEXT (M5 remainder): (1) restore test: dump demo DB, createdb fresh, restore.sh, run e2e known-answer readbacks or row counts; (2) isolation.js additions: user in two orgs cannot cross-read; removed member loses access; (3) rerun full regression if code changes; then M6 readiness report (untested limits: storage scale, ClickHouse path, Go agent build, Multies sign-in bridge pending Multies access, hosting pending approval; minute-bucket alert latency; webhook SSRF flag).
- Full regression state: unit 63/63, memberships 30/30, isolation 13/13, quotas 34/34 (2 proc), e2e.sh correct, alerting 14/14.

## 2026-11-20 18:06 Multies contract study (read-only clone at /tmp/multies-study, github.com/MaisySen/multies)
- better-auth + organization plugin. members(organization_id, user_id, role default 'member'); sessions carry active_organization_id; invitations auto-join on first sign-in by verified email (guards.ts resolveAuth). Matches Monitoring's org_memberships/activeOrgId/invite-by-email design.
- Sign-in: local password, direct social (Google/GitHub self-host), external IdP via Auth0 genericOAuth. Multies is an OIDC CLIENT, not a provider for apps.
- Multies IS an OAuth 2.1 authorization server (src/server/services/developer/oauth.ts, RFC 7591 DCR, PKCE S256, hashed codes/refresh, 1h access tokens) but scopes are mcp:read/mcp:write only and tokens resolve only on the MCP guard (routes/v1.ts line ~181).
- Workspace API keys mm_live_ are org-scoped, act as workspace admin (or read), hashed at rest (services/developer/api-keys.ts). Session and agent key never stand in for each other.
- Bridge design options (to write up in docs/MULTIES-BRIDGE.md): A) Monitoring as OAuth client (needs Multies scope extension = Multies writes, external dep); B) workspace API key org binding (works today, org-level not person-level); C) Monitoring-side generic OIDC client sign-in buildable+testable NOW against a local stub IdP.
- Parent 18:05: don't stop at readiness report; continue testable gaps: agent build/onboarding, bounded storage/load/failure tests; confirm bridge study (this). 
- TODO next runs: docs/MULTIES-BRIDGE.md; Monitoring generic OIDC client sign-in + stub-IdP test; Go agent build (go1.26.6 at /usr/local/go/bin/go, agent in artifacts/agent?); bench/scale + bench/resilience bounded runs; docs/READINESS.md; MODIFICATIONS.md refresh.

## 2026-11-20 18:21 - OIDC hardened to tenant-isolation bar (post-review rework)
- Review found the first OIDC cut unsafe: orgs matched by display name (cross-issuer/cross-name hijack),
  users matched by email (account linking), no id_token verification, no downgrade/revocation sync.
- Fixed: sso_identities (issuer, sub) binding; sso_org_bindings (issuer, external id) binding; membership
  source column ('local'|'sso'); RS256+JWKS id_token verification with iss/aud/exp/nonce; per-login sync of
  sso-sourced memberships (downgrade + revoke) with last-admin guard; email-linking of existing accounts refused.
- bench/security/oidc.js rewritten: two stub IdPs (real RSA keys, JWKS, one-time codes), 25/25 covering
  happy path, idempotent re-login, email-link refusal, downgrade, revocation, last-admin guard, local-grant
  retention, unverified email, state mismatch, tampered cookie, code replay, five id_token adversarial modes
  (sig/iss/aud/exp/nonce), cross-issuer same-sub/email/org-name isolation, SSO account has no password.
- Regression after rework: unit 63/63, memberships 40/40. Migration 6 added (ALTER org_memberships + 2 tables).

## 2026-11-20 18:26 - SSO fail-closed sync + session freshness
- Second review round: last-admin retention would have preserved revoked provider authority. Replaced with
  fail-closed: claims always apply to sso-sourced grants; a warning is logged when an org ends admin-less;
  recovery is a separately authorized local grant only.
- Verified roles are read from the DB per request (resolveMembership -> listMemberships, no session cache),
  so existing sessions converge the moment a sync commits. Documented freshness bound in MULTIES-BRIDGE.md:
  provider changes apply at next SSO login; no push revocation channel exists.
- oidc.js now 29/29, adding: fail-closed sole-admin downgrade (org admin-less), pre-downgrade session loses
  admin (403 on admin route), revocation with missing claims clears old-session org access, recovery via
  local grant on the same old session, concurrent login/removal settles consistently without 500.
- Regression: unit 63/63, memberships 40/40.

## 2026-11-20 18:35 - Bounded SSO freshness + sync ordering; session-tz bug found and fixed
- Claim syncs now apply strictly in authentication order: id_token auth_time (else iat) is stored on
  sso_identities.last_sync_at; older callbacks create a session but never re-apply stale grants.
- SSO sessions get a bounded TTL (MONITORING_OIDC_SESSION_TTL_HOURS, default 12h); expiry fails closed.
  This is the documented worst-case revocation bound for a session that never logs in again.
- Found while testing: sessions.expire was timestamp-without-tz; node-pg writes UTC, reads local, silently
  shortening every session by the server offset (invisible at 7d TTL). Migration 8 converts to timestamptz
  (USING expire AT TIME ZONE 'UTC'). Real pre-existing bug.
- Middleware now accepts kind 'sso' sessions as user sessions.
- oidc.js 32/32 (adds stale-callback-cannot-restore, forward-order still applies, TTL value, expiry fail-close).
- Regression: unit 63/63, memberships 40/40.
- NEXT: Go agent build died OOM (compile signal: killed during go mod tidy/build with go1.26.11 toolchain).
  Retry staged: cd agent/_build && GOFLAGS=-p=1 go mod tidy, then go test/build with -p 1. Builder + _build
  exist. Then verify.sh end-to-end onboarding, bench/scale + bench/resilience bounded runs, READINESS.md.

## 2026-11-20 18:38 - SSO renewal loophole closed (uncommitted-then-committed in next entry context)
- updateSession (org switch) reset expire to now+7d for ALL sessions, silently extending SSO sessions past
  the 12h bound. Fixed: sso-kind sessions keep their original absolute expiry on update.
- IN REVIEW (parent 18:35): ordering clock must be iat only (auth_time dates authentication, not claim
  issuance; long-lived provider sessions keep a constant auth_time and would block fresh claims forever).
  Equal-iat ties must fail closed (apply removals/downgrades, never grants/upgrades). Stub must resolve
  claims at token-exchange time (real provider contract), with force-iat test hooks. Tests to add: repeated
  logins with constant auth_time still sync; out-of-order completion returns current claims; equal-iat tie
  never restores grants; org switch does not extend SSO expiry. NOT YET DONE - code still uses
  auth_time-preferred syncClock and lacks tie handling; oidc.js 32/32 reflects the old model.

## 2026-11-20 18:45 - iat-only ordering + fail-closed ties + exchange-time claims
- syncClock is now id_token iat only; auth_time is never used for ordering (it dates the provider login).
- Equal-iat ties fail closed: removals/downgrades apply, inserts/upgrades skipped; strictly-older claims
  skip the whole sync (session still created); newer claims apply fully and advance last_sync_at.
- Stub IdP now resolves claims at token-exchange time (the documented provider contract for B2) and holds
  a constant auth_time, with a force-iat hook.
- oidc.js 38/38, adding: exchange-time claim resolution (late completion returns current claims), constant
  auth_time still syncs revocations, four tie cases (downgrade applies, upgrade never restores, removal
  applies, re-grant never happens), strictly-older skip, org switch preserves absolute SSO expiry.
- Test lessons: forced iat must stay within the 60s future skew; ties are deterministic only via forced iat.
- Regression: unit 63/63, memberships 40/40.

## 2026-11-20 19:01 - Agent: build environment limit + onboarding verified server-side
- Full agent binary build is environmentally blocked in this 2GB sandbox: compiling
  github.com/aws/aws-sdk-go-v2/service/ec2 and DataDog/datadog-api-client-go/v2 (pulled by
  resourcedetectionprocessor and the datadog receiver) OOMs even with -p 1, GOGC=5/10, GOMEMLIMIT 1-1.45GiB.
  Toolchain go1.26.11 + builder + module cache all fine; this is a RAM ceiling, not a code problem.
  Needs a CI runner or larger host (build.sh unchanged). NOT a silent skip: tracked as an open dependency.
- Config translation layer (config.go + logoperator.go) verified standalone: 6/6 Go tests pass in a scratch
  module (only yaml dep; excludes the collector tree). Covers the config shape the installer writes.
- Server-side onboarding verified end-to-end: /install.sh embeds the server-computed sha256 of the hosted
  binary (verified byte-identical download), refuses plain-HTTP third-party sources without a pinned
  checksum, and /account/agent renders the correct one-liner (screenshot, visually inspected).
- datacat.example.yaml renamed to monitoring.example.yaml (README/verify.sh already referenced that name).
- NEXT: bounded bench/scale + bench/resilience runs; docs/READINESS.md + MODIFICATIONS.md refresh.

## 2026-11-20 19:06 - Bounded scale run + install placeholder fix
- bench/scale/loadgen.js bounded run (RUN=scale-1795161821, 20 hosts/10 svc/50 tps/60s/2k cardinality):
  sent 19,281 spans + 3,191 logs + 12,640 counter points; intake p50 10ms p99 73ms; 0 errors.
  Stored: spans 19,281/19,281 exact; logs 3,191/3,191 exact; metric points under the run tag 13,440
  (>= 12,640 sent; overage consistent with host-metric gauge points also carrying the tag but not counted
  in the generator's sent counter - counting ambiguity only, no loss). Org-scoped queries used for checks.
- /account/agent placeholder was shell-unsafe (MONITORING_API_KEY=<YOUR_API_KEY> parses as redirection);
  fixed to PASTE-YOUR-API-KEY in Misc.tsx + Docs.tsx; copy target verified identical to rendered text;
  no real key was present in the demo org, so no secret appeared in screenshots (commit 303f95c).
- Agent build authority gap (for parent): the repo's release workflow (ubuntu-latest runners) would compile
  the unchanged agent, but it triggers on pushing a v* tag to a GitHub remote = publishing the working copy
  + account/release changes. Not authorized. No no-cost route exists inside current authority; sandbox RAM
  (2GB) OOMs on two giant SDK packages. Needs: approval to use a CI-backed remote (e.g. private fork).

## 2026-11-20 19:08 - API key exposure fix (parent directive: treat as security issue, not preference)
- GET /api/ui/org no longer returns full API keys to anyone (previously admins got kind=api keys in full,
  which auto-filled the /account/agent install command and Docs examples). Routine responses carry only
  the hint (first4...last4). Keys are shown exactly once: the POST /ui/org/keys creation response.
- /account/agent: removed key autofill. Explicit flow: admin clicks "Create install key" -> new key named
  "Agent install key" is embedded in the commands once, in-page; non-admins are told to ask an admin.
  Rotation = revoke in Organization Settings + create new (documented in-page). Docs.tsx now always uses
  the PASTE-YOUR-API-KEY placeholder. Org key list renders hints only (defense in depth).
- Verified live (memtest, demo org): GET /ui/org has_key=false for admin; POST returns key once (32 chars);
  intake 202 with new key; old key unaffected; DELETE revokes and intake then 403. UI test (headless
  chrome): before creation, zero key-like strings in command blocks; screenshot agent-onboarding-masked.png
  contains no secret; after clicking create, banner + embedded key render (one-time display, not
  screenshotted). Test keys revoked afterwards.
- Regression: unit 63/63, memberships 40/40 (fresh DB), oidc 38/38.
- CI/private-repo build route: parent asked user for permission; do NOT push or tag until granted.

## 2026-11-20 19:26 - Resilience: real server bug found + fixed (pg pool crash on DB restart)
- server-only resilience variant (bench/resilience/server-only.js): app -> server OTLP intake -> Postgres,
  no agent binary. Found during bring-up: a Postgres fast restart crashed the whole API server with an
  uncaught 'error' event on the pg pool (idle client killed). Fix: pool.on('error') logs and recovers in
  lib/db/src/index.ts; in-flight queries still fail individually as retriable 503s. Verified: server now
  survives pg_ctl -m fast restart and keeps serving.
- Migration gap found + fixed: DBs created before OTLP log-attribute support never got
  logs.attributes/trace_id (no ALTER migration). Added migration 9; verified on the stale memtest DB
  (columns added, 3,193 rows intact) and fresh-DB unit tests still 63/63.
- Earlier scale-run stored-count verification (run scale-1795161821) was done against memtest's older
  logs schema (tags query); unaffected: spans/logs counts matched exactly.

## 2026-11-20 19:44 - Server-only resilience results (no agent binary)
Runner bench/resilience/server-only.js (app -> server OTLP -> Postgres; does NOT cover the agent disk
queue). 100 spans/s, 60s runs, fault at 20s. Evidence: bench/evidence/recovery/server-only-2026-11-20.json.
- baseline: 6000/6000 spans, 3000/3000 logs, 0 duplicates.
- server outage 15s (< 30s client retry budget): 0 spans lost, 0 dup; 51/3000 logs lost (stock OTEL log
  exporter retries less - known upstream limitation, the Monitoring span exporter's retry fix is what
  saved spans). Fresh data visible 1ms after recovery.
- server outage 45s (> budget): 4050/6000 spans and 2039/3000 logs lost - BUT gen ended at 60s, 5s before
  the server came back, so post-recovery delivery was never exercised; loss overstated by harness design.
  Rerun queued with SECONDS=110. This measures app-side bounded loss WITHOUT the agent; the agent's disk
  queue claim (upstream README) still needs the agent binary.
- db_restart: runner2's run was polluted (PG restart apparently never fired; generator stopped early);
  data discarded, clean rerun queued.
- Harness hardening: don't await gen 'exit' (lost SIGCHLD left zombie + pending promise; sandbox-specific).
  Poll summary line + child liveness instead, then SIGKILL the child.

## 2026-11-20 20:02 - Private repo created + build checks pushed; CI blocked by account quota
- User approved (WhatsApp "Yes" 19:57) creating a private GitHub repo for Monitoring + automated build
  checks (no release/deploy). Parent relayed the scope: private source upload + build checks only.
- Created https://github.com/MaisySen/Monitoring (private) via API using the stored GitHub credential
  (vault write-file, sandbox file deleted after use). Credential scan of the working copy before upload:
  only test IDs/lockfile hashes, no secrets. Pushed branch `develop` only; no tags (release.yml stays
  untriggered). Legal NOTICE/LICENSE/MODIFICATIONS.md included as-is.
- Added .github/workflows/build.yml: on push to develop, agent job (go test ./... + agent/release.sh,
  artifact upload, 7d retention) + server job (Postgres 14 service + api-server unit tests). contents:read
  only; no release/publish/deploy job.
- BLOCKER: both jobs fail at provisioning in seconds with zero steps and no logs. Evidence it is
  account-level, not the workflow: private repo another private account repo fails identically today (0 steps, 3s),
  another private account repo yesterday; public MaisySen/Mnet CI succeeded today. November usage API shows ~34,871
  Actions minutes consumed - private-repo hosted minutes are over quota and GitHub does not provision
  (public repos are unaffected). Rerun attempt failed the same way.
- Options (need a decision): (a) make the Monitoring repo public so build checks run free - exceeds the
  granted "private" scope, would publish source; (b) wait for the monthly quota reset and keep the repo
  private meanwhile; (c) provide a larger runner/host. The agent binary remains unbuilt.

## 2026-11-20 20:18 - CI failure cause grounded (per parent) + db_restart clean rerun
- GitHub check-run annotation (the authoritative job error): "The job was not started because recent
  account payments have failed or your spending limit needs to be increased. Please check the 'Billing &
  plans' section in your settings." That is the whole verified cause; which of the two billing branches
  applies is unknown from here. Reported to parent, who owns any permission/cost question. No visibility
  change, no more reruns.
- Harness bug fixed: pg_ctl restart inherited the execSync stdio pipe (postmaster keeps it open), so node
  never saw EOF and the runner froze. PG_RESTART_CMD now redirects to a log file.
- db_restart CLEAN rerun (SECONDS=110, fault at 20s, ~90s of post-restart traffic): 11,000/11,000 spans,
  5,500/5,500 logs, 0 duplicates - zero loss through a real Postgres fast restart under load, with the
  pool error handler holding. Earlier "polluted" reading was the harness PATH/pipe bugs, not the product.

## 2026-11-20 20:19 - server_outage_long clean rerun (SECONDS=110, post-recovery traffic present)
- Server down 45s at 100 spans/s: 52/11,000 spans lost (0.47%), 0 duplicates; 1,880/5,500 logs lost
  (stock OTEL log exporter retry is weaker - matches upstream README's known limitation); fresh data
  visible 13ms after recovery. Evidence: bench/evidence/recovery/server-only-2026-11-20-rerun.json.
- READINESS.md updated with these numbers; the "pending rerun" gap is closed. Remaining explicit gap:
  the agent disk-queue layer (upstream claims) - needs the agent binary.

## 2026-11-20 20:22 Public visibility (temporary, user-authorized)
- User authorized "Keep it public until fully build" (WhatsApp, verified). Repo flipped to PUBLIC
  after a full-history scrub (git filter-repo): other private account repo names, personal
  identifiers and contact details removed; remaining handle references are the public handle itself.
  No credentials, tokens or private user data in tree or history (scanned: ghp_/pat/sk-/AKIA/key
  patterns + identifier grep; the only key material in history is redaction-test fixture data).
- Rationale: account-level billing restriction blocks hosted-runner provisioning for PRIVATE repos
  (GitHub's own check-run annotation: recent account payments failed / spending limit increase
  needed). Public repos get hosted runners free; this is the user's chosen route to unblock the
  agent binary build. No promise the restriction itself is fixed; it is bypassed per account policy.
- Return-to-private: owed at the fully-built endpoint = green agent build + real onboarding verified
  against the downloaded artifact. Not from readiness docs. Recurring wake carries the follow-through.
- Force-push note: history was rewritten (scrub) and force-pushed; the pre-scrub history exists only
  in the old private remote refs, now overwritten.

## 2026-11-20 21:03 Real agent onboarding verified (CI artifact) + two genuine fixes
- Downloaded the CI-built agent artifact (run 44710994706, artifact 14618621071; SHA256SUMS verified)
  and ran agent/verify.sh end-to-end against a fresh stack (port 4600, fresh DB): host registered
  (agent_version 0.1.0), 182 metric series / 51 names incl. smoke metrics, 4/4 logs trace-correlated,
  both smoke spans in storage with resource/env/host, exit 0.
- Fix 1 (fresh-install error): flushSpanStats compacted before ensureSpanStats, so the first flush on
  a new install logged "relation span_stats does not exist". Order swapped; zero compaction errors since.
- Fix 2 (vacuous verify, upstream): verify.sh queried spans right after SIGTERM - before the agent's
  shutdown flush landed - AND matched hex OTLP trace ids against storage's low-64-bit decimal form, so
  the span/log storage checks could only ever return 0 rows while exiting 0. verify.sh now polls up to
  90s for the flushed spans, converts hex to the storage decimal form, and FAILS loudly on missing rows.
  Confirmed the failure mode fires (caught the race), then the fixed script passes with real rows.
- Commit 65f27d7. Full app->agent->server->Postgres recovery bench (all 5 scenarios) launched against
  the same artifact binary under its own restart loop; measured results in the 23:05 section below.

## 2026-11-20 23:05 Recovery bench - measured, then found to be app -> server DIRECT (agent bypassed)
- CORRECTION (23:25): the generator env passed MONITORING_URL through, and in the SDK config
  MONITORING_URL means "talk straight to the server" (sdks/node/config.js base resolution) - so the
  agent was a healthy bystander in all 5 scenarios. Proof: stored rows carry the generator's resource
  identity (env=resilience, host=modal), not the agent's (env=recovery, host=recovery-bench-host), and
  agent internal telemetry showed zero receiver traffic in a rerun. The numbers below are valid
  app->server-direct measurements (they supersede the lower-rate server-only runs); the agent_restart
  scenario was vacuous (it killed a process nothing was using); agent-mediated results are pending the
  wired rerun (recovery.js now has TOPOLOGY=agent with an empirical resource-identity assertion so a
  wiring regression fails loudly). Evidence file renamed: bench/evidence/recovery/app-direct-2026-11-20.json.
- CI-built agent binary (CI run 44710994706, artifact 14618621071, SHA256SUMS-verified) was running
  under its own restart loop; numbered spans/logs carry seq attributes; every claim below verified
  against Postgres directly after the run.
- baseline (200 spans/s, 90s): 18,000/18,000 spans, 9,000/9,000 logs, 0 duplicates.
- agent_restart (SIGTERM, health-gated restart): 18,000/18,000 spans, 9,000/9,000 logs, 0 duplicates -
  VACUOUS under the wiring bug (nothing routed through the agent); stricken from the record.
- db_restart (Postgres fast restart): 18,000/18,000 spans, 9,000/9,000 logs, 0 duplicates, fresh data
  0.56s after recovery. Valid as an app-direct measurement.
- backend_outage (server SIGKILL, 60s), app-direct: 617/18,000 spans lost (one contiguous kill-window
  range, seq 5810-6426) and 3,888/9,000 logs lost (one contiguous ~32s window from the kill plus three
  short windows later in the outage). With the agent idle, this loss is entirely app-side vs a dead
  server: the stock OTLP log exporter drops a batch on the first transport error and the
  BatchLogRecordProcessor discards it, while the patched span exporter's 30s retry budget covers all
  but the kill window. SDK fix in flight (retrying log exporter + 65536-record log queue) will be
  validated against this exact scenario in both topologies.
- long_outage (server SIGKILL, 240s at 600 spans/s), app-direct: bounded-loss profile -
  56,078/180,000 spans and 19,931/90,000 logs stored, 0 duplicates. Loss is dominated by app-side
  buffering limits (batch processor queue sizes, 30s export retry budget) over an outage far beyond
  app-side capacity. Note: zero duplicates reflects this run's server intake + app exporters; it is
  not evidence about the agent's disk queue, which carried no app data.

## 2026-11-20 22:35 B1 Multies bridge - Monitoring half built + tested (11/11)
- Migration 10 (multies_bindings), lib/multies.ts (verify via Multies v1 GET /api/v1/domains through the
  SSRF-checked HTTP path), routes POST/GET/DELETE /api/ui/org/multies-binding (admin write, member read).
- Contract honesty: the v1 API has no whoami; key validity is proven, workspace label is self-declared.
  Raw key never stored (sha256 + last-4 hint). Binding is never a sign-in path.
- bench/security/multies-bridge.js 11/11 against a stub Multies API, two server profiles (allow-private
  on/off): format refusal before network, rejected key not bound, member 403, hash-only storage,
  redacted reads, re-bind replace, unbind, private URL refused without the env flag.
- Harness learning: login returns clearing+new sid cookies; bench cookie jars must be last-wins.
- Live verification against a real Multies instance remains the external dependency for B1; B2 unchanged
  (Multies write authority needed).

## 2026-11-21 00:31 resilience bench, agent topology (run wo501, 6/6 scenarios, DB-verified)
- Harness: recovery.js TOPOLOGY=agent strips MONITORING_URL from the generator (SDK config.js would otherwise go app->server direct), sets MONITORING_AGENT_URL, and asserts every stored row carries the agent resource identity (env=recovery, host=recovery-bench-host), failing as topology_violation otherwise. 0 violations.
- Agent: otelcol-contrib, file_storage disk queue, memory_limiter, batch. Instrumentation delta vs generated default config verified by diff: debug tap, pprof ext, bench.log path, telemetry metrics only; receivers/processors/exporter queue/retry/batch/memory_limiter/storage byte-identical, so routing/buffering/retry behavior is the shipped behavior.
- SDK: RetryingLogExporter + maxQueueSize 65536 (commit e4ef049).
- Results (rows vs unique ids in PostgreSQL, per service):
  - baseline: 18000/18000 spans, 9000/9000 logs, 0 missing, 0 dup, fresh 1.037s
  - backend_outage (server SIGKILL 60s): 18000/18000, 9000/9000, 0/0, fresh 11.767s, drained 25.235s. Same fault app-direct (pre-fix SDK) lost 617 spans + 3888 logs.
  - agent_restart (SIGTERM): 18000/18000, 9000/9000, 0/0, fresh 1.564s
  - db_restart: 18000/18000, 9000/9000, 0/0, fresh 0.521s
  - long_outage (240s outage at 600 spans/s): 180000/180000, 90000/90000, 0/0, fresh 25.955s, drained 0.374s after end
  - agent_kill_pending (SIGKILL with pending disk queue, files snapshotted at kill: traces 16MiB, logs 8MiB; only 5867/18000 spans stored at kill): 18000/18000, 9000/9000, 0/0 after agent restart. Disk queue survives SIGKILL; no redelivery duplicates.
- Stage counters (566 prometheus scrapes, 2s cadence): max queue depth 581/1000 trace requests, 244/1000 log requests; receiver_refused = 0 for both signals across the whole suite (memory_limiter never engaged at 600 spans/s); exporter send_failed/enqueue_failed series never appeared.
- Caveats: baseline rows verified live at collection but absent from final DB (recagent recreated between wrapper attempts; other 5 scenarios present in final DB state). Server intake has no idempotency keys: end-to-end semantics are at-least-once; 0 duplicates observed in these runs does not prove duplicates impossible (a response lost after commit would redeliver).
- Evidence: bench/evidence/recovery/agent-2026-11-21.json, recovery-agent2.jsonl, tele-agent2.out; app-direct comparison in app-direct-2026-11-20.json + original-logs-2026-11-20/.

## 2026-11-21 00:59 acceptance layer: shipped default config (run cbazi, 6/6, DB-verified)
- Agent run via the generated default config (run -c agent-recovery.yaml, debug off, install.sh path) + SDK packed from the committed repo. Same 6 scenarios as wo501.
- All 6 zero-loss, zero duplicates, all services present with exact counts in the FINAL DB state (unlike wo501's baseline caveat): baseline/backend_outage/agent_restart/db_restart/agent_kill_pending 18000 spans + 9000 logs; long_outage 180000 + 90000; agent_kill_pending stored 5847/18000 at SIGKILL, exact delivery after restart.
- Default onboarding/recovery therefore matches the instrumented diagnostic runs in all measured scenarios. Scope note preserved: measured scenarios only, at-least-once semantics, zero observed duplicates is not a proof.
- Direct-topology SDK-fix validation (run okoz5): backend_outage log loss 3888->100, long_outage log loss 70069->6489; span-path cause attribution limited to timing+app-log evidence per parent 00:41.
- Evidence: bench/evidence/recovery/acceptance-2026-11-21.json, recovery-acceptance.jsonl, direct-fixed-2026-11-21.json.
