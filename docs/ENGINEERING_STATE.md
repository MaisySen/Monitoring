# Engineering state (2026-11-20)

Working copy of the Monitoring feature build. Local only: not published anywhere; Multies repo untouched.

## Done and proven (each on the production build against PostgreSQL 14)
- M1 rebrand to "Monitoring" (legal NOTICE/attribution kept; MODIFICATIONS.md added). 60/60 unit tests, SDK suites.
- M2 multi-org membership: org_memberships + migration 4 backfill, org switcher, roles, invites for existing
  accounts, last-admin guard. bench/security/memberships.js 30/30; isolation.js 13/13; scripts/e2e.sh correct.
- M3 per-org quotas: org_quotas/org_usage_daily (migration 5), enforcement at intake (points/logs/spans per day,
  series cap, per-minute bytes), GET/PUT /api/ui/org/quotas, Usage & Limits UI tab. bench/security/quotas.js 21/21;
  memberships 30/30 + isolation 13/13 + e2e re-run green after quota changes.

## Spool hardening + intake idempotency (2026-11-21, evidence: bench/evidence/resilience/spool-idempotency-2026-11-21.md)
- Spool: cap accounting counts in-flight .claim files; oversized batches self-evict without throwing;
  read-only-dir writes never throw; stale claims (60 s) reclaimed with oldest-first drain order
  (sort fixed to use embedded write ts); concurrent writers bounded at cap + one batch.
- Intake: spans idempotent per (org_id, trace_id, span_id) - dedupe SELECT before insert,
  spans_uniq unique index (new migration collapses pre-existing dupes), ON CONFLICT backstop,
  rollups/trace-metrics fed fresh spans only. Verified: double POST of 5 spans = 5 rows, stats hits 5;
  new-trace negative control inserts.
- Still at-least-once by design: logs duplicate-able on lost response, metrics unspooled, CH path
  no dedupe, spool cap + outage drops oldest. Documented in sdks/node/README.md.

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

## 2026-11-21 01:04 M5 remainder closed: regression rerun on current tree
- memberships.js 40/40 PASS (fresh memtest2, server 4601, current build). The suite now covers the M5
  remainder items: a user in two orgs sees only the active org's data (sections 8/14), a removed member
  loses access with session fallback (section 11), last-admin guards, per-org roles. The 18:06 note
  listing these as TODO was stale.
- isolation.js 13/13 PASS (fresh iso2, server 4602, current build): org boundaries, key revocation,
  malformed payloads, redaction.
- Restore test executed earlier this run (see 01:00 entry above + bench/evidence/restore-test-2026-11-21.json).
- Evidence: bench/evidence/security/memberships-2026-11-21.json, isolation-2026-11-21.json.
- M5 is now fully closed. Remaining build items: M4 demo journey + UI screenshots; M6 readiness document
  assembly; B2 Multies OIDC (blocked on Multies-write authority); hosting/deployment (blocked, not authorized).

## 2026-11-21 01:52 M4 demo journey complete (visually verified)
- bench/demo/seed-demo.js: fresh server -> setup/login/API key -> 3 services seeded (1,743 spans,
  816 logs, 543+ metric points over 30 min, ~5% errors) -> dashboard (3 widgets) -> webhook channel +
  metric monitor driven into Alert with a real HTTP 200 delivery -> second org "Acme Staging" seeded.
  DEMO_SUMMARY: dashboardId g87-6uu-sog, monitorId 1, monitorState Alert, alertWebhookDelivered true.
- bench/demo/screenshot-demo.mjs (puppeteer-core + system Chrome, real login form): 7 screenshots in
  bench/evidence/demo/, each visually inspected after capture: apm-services (3 services, error-rate
  attention card, monitor-alerting banner), logs (816 entries, severity facets), dashboard (3 live
  timeseries), monitors list (1 ALERT), monitor-firing (status history OK->Alert + delivery HTTP 200),
  org-settings-usage (Usage & Limits tab, counts matching the seeded totals), org-switcher-open
  (both orgs, roles).
- Needs MONITORING_ALLOW_PRIVATE_WEBHOOKS=true for the loopback alert sink (documented in bench/demo/README.md).

## 2026-11-21 02:48 span_stats bootstrap double-count: found, fixed, verified
- Defect (found via demo screenshot review): ensureSpanStats was lazy (first flush or first UI query).
  On a fresh install its backfill used max(span id) AT THAT MOMENT, which included spans intake had
  already recorded into the in-memory pending aggregates; those spans were counted twice (backfill +
  pending flush). Measured: service catalog showed exactly 2x root spans per service (724 vs 362).
- Fix: artifacts/api-server/src/index.ts awaits ensureSpanStats() at startup BEFORE the listener opens,
  so backfill's maxId can never include intake-recorded spans (no-op under ClickHouse and on existing
  installs; upgrade path unchanged - pre-boot spans backfilled exactly once).
- Regression bench: bench/correctness/span-stats-once.js asserts rollup hits == raw roots == sent, and
  error sums, across two flush cycles. Negative control on the OLD build: 6 FAILs with exactly 2x
  (80/40, 50/25, errors 10/5). Fixed build on a fresh DB: 10/10 PASS.
- Demo reseeded on the fixed build (DEMO_SUMMARY Alert + delivery as before); span_stats hits == 362 ==
  raw roots per service; all 7 screenshots recaptured and the catalog now reads 362 requests/service.

## 2026-11-21 03:25 axes fix, peak labels, soak + ClickHouse verified, agent build blocked on RAM
- Charts rendered without axes (React 19 + recharts 2.15.4 dropped children passed as one JSX
  fragment); fixed by passing axis elements as a plain array. DOM-verified; screenshots recaptured.
- Peak labels on small charts collided (one max per series-third); labels now de-collided with a
  minimum separation, and timeseries widget headers show the query as a subtitle so the aggregation
  behind plotted values is visible on the dashboard.
- Soak (bench/evidence/scale/soak-600sps-2026-11-21.md): 620 spans/s x 5 min, zero loss —
  186,223/186,223 spans, 30,586/30,586 logs, 68,000/68,000 sent metric points, 0/2,450 errors.
- ClickHouse path end-to-end (bench/evidence/clickhouse/ch-e2e-2026-11-21.md): fresh CH 26.12.1.59,
  schema auto-created, spans 5,720/5,720, logs 924/924, points 620/620, 0 errors; services list,
  span search, trace view, log search and metrics query all served from CH; span_stats hits match
  is_top_level roots exactly (parent_id='0' is the wrong probe — entry spans, not parentless spans).
- Agent from-scratch build (bench/evidence/agent-build/sandbox-build-2026-11-21.md): blocked by
  sandbox RAM — kernel OOM kills the compile of the datadog-api-client-go datadogV2 dependency even
  with -p 1, all other services stopped, and -gcflags='all=-l'. Environment limit, not a defect;
  build.sh unchanged (needs a 4 GB+ machine).

## Transactional rollups + outage e2e (2026-11-21, build 09697a7, CI run 44778913378 SUCCESS)
- span_stats rollup rows now insert in the SAME transaction as the span rows (aggregateSpanStats +
  insertSpanStatsTx); a crash can no longer split rows from rollups. Verified: 4 parallel identical
  POSTs and sequential double-POST both 5 rows / 5 hits.
- Outage e2e (45 s, spool ON): spans 11,000/11,000 and logs 5,500/5,500, 0 duplicates both signals
  (round 4: the kill-second 'loss' was a drain-serialization bug - drained logs were stored with
  empty service/host because ResourceImpl serializes as _rawAttributes/_memoizedAttributes;
  slimRecord now resolves via _memoizedAttributes / first-wins _rawAttributes). See round 4 in the
  spool-idempotency evidence md.

## 2026-11-21 05:00 - Product direction pivot (user critique)
- User (04:57): current build is "primal ordinary piece that no one would use". Correct: the UI is a
  Datadog-clone IA for observability professionals; Multies customers are small businesses.
- docs/PRODUCT-PLAN.md holds the revised plan: four-beat journey (connect -> Now/Problems -> evidence
  chain -> next step), zero-config onboarding, auto default monitors, exception grouping, deploy
  correlation, zero-instrumentation uptime checks, Multies-native alert delivery (P2, bridge-held).
  Dashboard builder/metrics explorer/host map demoted to Advanced, not deleted.
- UI implementation pauses until the plan gets a user/parent reaction. Backend/reliability work unaffected.

## 2026-11-21 05:03 - trace.* derived points now transactional with span rows
- writeSpans (PG path): trace.<op>.hits/errors/duration points for fresh spans insert in the SAME
  intake transaction as span rows + span_stats (deriveTracePoints + insertTracePointsTx). Series rows
  and the points-quota charge resolve/charge before the tx (charge-on-attempt, matching span
  admission; a partially-duplicated batch can over-admit the dupe-derived points never inserted -
  disclosed). ClickHouse path unchanged (no idempotent span store there; documented limitation).
  The postcommit-crash undercount window for trace.* is CLOSED; host_services links stay
  self-healing outside the tx.
- Verified (fresh DB, prod build): double POST of one 400-span batch (40 errors) ->
  spans 400/errors 40, trace.hits 400 (not 800), trace.errors 40, trace.duration avg 1.0s.
  Note: OTLP server spans land under the operation name "server.request" (decoder naming), so the
  series are trace.server.request.* — expected, not a misroute.
- Pending verification next run: precommit SIGKILL -> 0 spans AND 0 trace points, retry -> equal;
  lost-response proxy rerun. Harness: /tmp/trace-tx-verify.js, /tmp/resp-drop-proxy.js.

### trace.* transactionality: precommit fault injection (2026-11-21 05:04, build a5f4eed)
- 30,000-span batch (7.9 MB), server SIGKILLed ~120 ms into the request, curl exit 52.
  Post-kill: 0 spans, 0 trace points, 0 series rows for that service (full rollback; the kill
  landed before/independent of series resolution, which happens pre-tx on its own connection).
  Retry of the identical payload: 30,000 spans, trace.hits sum 30,000, exact 1:1. PASS.
- Process note: first kill attempt raced a fast 3,000-span insert (POST completed 200 before the
  kill) - that batch committed fully and consistently; invalid as a fault test, counted as neither
  pass nor fail. Retried with a 10x batch.
- Lost-response proxy rerun for this change still pending (harness /tmp/resp-drop-proxy.js).

### trace.* transactionality: lost-response proxy (2026-11-21 05:04, build a5f4eed)
- 500-span batch POSTed through a proxy that destroys the client socket when the upstream
  response arrives (client curl exit 52; server had committed). Direct retry: 200.
  Final: 500 spans, trace.hits sum 500 - re-delivery deduped, derived points counted once. PASS.
- Both interruption boundaries now verified for transactional trace.* points (precommit SIGKILL
  30k batch + postcommit lost response). The round-5 disclosure "trace.* can undercount one batch
  in the postcommit-crash window" is resolved on the PG path.

## 2026-11-21 05:55 - P0 backend: auto default monitors + /ui/now
- jobs/autoMonitors.ts: first time a service sends spans, two default monitors are created
  (advisory-locked, tagged monitoring.auto:true + auto:service:<svc>, never blocks intake):
  "Errors in <svc>" (trace-analytics, >=5 error spans/10m, message says the threshold is an
  untuned starting point) and "<svc> stopped sending data" (trace count < 0, never true with
  data, notify_no_data + 10m timeframe -> OK while receiving, No Data when silent).
- GET /api/ui/now: honest service health (ok / degraded with raw counts and baseline /
  low = too little traffic to judge / quiet = no data 10m+, "silence is not proof of failure"),
  firing-monitor problems feed (service + auto tags), intake status for onboarding detection.
- Verified on the production build, fresh DB: empty org -> receiving:false, zero services,
  zero problems (no invented health). Seeded shop-api (300 spans, 0 errors) + billing
  (120 spans, 12 errors): 4 auto monitors created; "Errors in billing" Alert, others OK;
  /ui/now: billing degraded "12 errors in 120 requests (10.0%)", shop-api ok. Unit 63/63.
- Found and fixed in testing: first silence-monitor query (>= 0) alerted while data flowed -
  inverted comparator bug caught by the live check, fixed to < 0.
- Pending: silence monitor actually firing after 10m quiet (needs a timed soak); Now page UI;
  onboarding flow UI. Harness: /tmp/p0-verify.js.

## 2026-11-21 06:06 - /ui/now request-level correctness + Now page UI
- Parent correctness concern verified: span counts are NOT request counts. Finding:
  aggregateSpanStats already filters to entry spans (isTopLevel only), so span_stats hits ARE
  operation counts - verified equal to count(spans where is_top_level=1) per service with a
  nested-span control (frontend: 50 entry spans vs 200 total stored spans). /ui/now wording now
  says "operations", "No errors observed" (not proof of health), and default monitors carry a
  [Default] prefix so the untuned thresholds stay visibly provisional.
- Now page UI replaces the tile home (pages/Misc.tsx Home): Problems feed (firing monitors,
  service link, since), Services health list (state dot + honest note), honest empty state,
  30s refetch, footer disclaimer. Visually verified (headless Chrome, real login): billing
  degraded 12/120 (10.0%) with ALERT problem row; frontend/shop-api "No errors observed".

## 2026-11-21 06:56 AEDT - Onboarding page, timed silence soak, P1 error groups

### Onboarding page (38deb37)
- `/onboarding` "Connect your app": live status card polling `/ui/now` every 3s (honest
  "Waiting for data..." with client-side troubleshooting caveat -> "Receiving data from <svc>"
  + link to Now), API-key step linking to Organization Settings (placeholder key in snippets,
  no full-key autofill), stack tabs Node.js / Python / any-OTLP. Now empty state links here.
- Visually verified (headless Chrome): receiving state rendered correctly.

### Timed silence soak - PASSED (real wait, no simulation)
- Fresh org, soak-svc seeded 50 spans 06:44:12 AEDT, then silence. At 06:55:09:
  `[Default] soak-svc stopped sending data` = **No Data**; `/api/ui/now` shows soak-svc
  `quiet` ("No data for 10 minutes ... silence alone is not proof of failure"). ~11 min to flip
  (10m no-data timeframe + evaluator cadence).

### P1: error fingerprint grouping (this commit)
- `query/errorGroups.ts`: fingerprint = sha1(service | error.type | normalized error.message);
  normalization replaces uuids/ips/hex/timestamps/numbers. Stack frames and env deliberately
  excluded from the fingerprint (documented why in file header).
- Migration 11: `error_groups` table. Upserted inside the span intake transaction from FRESH
  error spans only (same atomicity/dedup story as span_stats).
- `GET /api/ui/errors?service=` (PG; `supported:false` on CH backend - grouping is PG-only
  for now, same class of limitation as the trace-metric transactionality).
- `/errors` page + nav; Now Problems card links error problems to their error groups.
- LIVE VERIFY (soak org, err-svc): 7 TypeErrors ("user <n> not found") collapsed to ONE group
  count=7, 3 KeyErrors to one group count=3. The identical batch re-delivered (lost-response
  retry) did NOT double-count (still 7/3). env=prod captured from OTLP resource attrs.
  Bonus: the journey closes - err-svc's `[Default] Errors in err-svc` monitor went Alert.
- Unit: 68/68 pass (5 new error-groups tests incl. normalization, stability, generic grouping).

## 2026-11-21 07:02 AEDT - Parent correctness review fixes (this commit)

Three product-correctness gaps from parent review, fixed and live-verified:
1. LOW TRAFFIC MUST NOT SUPPRESS ERRORS: service-health computation extracted to
   query/serviceHealth.ts (pure, unit-tested). Low-traffic services with observed errors now
   read "<n> errors in <m> operations in the last 5 minutes - too little traffic to judge
   overall health" (errors AND uncertainty, not one or the other).
2. PER-GROUP EVIDENCE: GET /api/ui/errors/:fingerprint/spans returns spans matching ONE group
   (fingerprint recomputed from stored span meta over a bounded 5000-span/7-day scan;
   scanned/scanTruncated reported). /errors/:fingerprint detail page lists matching traces
   with per-trace links. Live negative control: TypeError group returned exactly its 9 spans,
   zero of the 3 KeyError spans.
3. ENV SCOPE HONESTY: migration 12 replaces single env label with envs text[] (union-merge at
   upsert, bounded 10; conditional DO block handles both fresh and migrated databases). Live
   verify: same error shape sent from prod and staging merged into one group count=9 with
   envs=["prod","staging"] displayed; UI footnote states env does not split groups.
Unit: 74/74 (6 new: env merge, low-traffic-with-errors, quiet wording, degraded thresholds).

### Org isolation, error groups (live negative control, 07:04 AEDT)
Second org (same user, switched session): GET /api/ui/errors returned 0 groups; GET
/api/ui/errors/<org-A-fingerprint>/spans returned 404; seeding the SAME error shape into org B
produced an independent row under the same fingerprint hash, count=1, while org A's group was
untouched (its count moved 9 -> 10 only because the first harness attempt, before the
org-select fix, seeded one span into org A by mistake - accounted for, not leakage).
Harness lesson recorded: /ui/orgs does not switch the session; /ui/org/select is required.

### Isolation suite extended (this commit): 16/16
bench/security/isolation.js now covers error groups: org A's groups invisible in org B's
list, cross-org group detail 404, plus org-A sanity. Ran against a fresh server+database:
16/16 pass (was 13/13 before error groups; +3 new checks).

## 2026-11-21 07:09 AEDT - Deploy/version correlation, hypothesis-labeled (this commit)

GET /api/ui/errors/:fingerprint/spans now returns versionCorrelation: errorsByVersion (all
scanned matches, NOT capped by the 50-row list limit) and trafficByVersion (base rate over
the same 7-day window). Detail page shows a "Version correlation (hypothesis only)" card with
both columns: "A concentration is a lead to investigate, not proof a version caused the
errors." Live verify: seeded 4 errors on v1.4.0 + 26 clean spans on v1.3.0 -> card shows
1.4.0: 4 errors / 4 spans vs 1.3.0: 0 / 26, making the concentration visibly real rather than
traffic-proportional. Version source: OTLP service.version (already parsed at intake).

## 2026-11-21 07:14 AEDT - Correlation comparability fixes (this commit)

Parent review found the first correlation card non-comparable. Fixed:
- Numerator/denominator comparability: coverage is explicit and shown beside the card
  (matchedTotal of groupCount, scanned, scanTruncated). Live truncation test with
  MONITORING_ERROR_SCAN_LIMIT=10: coverage read 9 of 14, scanned=10, scanTruncated=true.
- Denominator is now ENTRY SPANS (operations), not raw spans, so instrumentation depth does
  not distort exposure; card says entry spans approximate operations, not requests.
- Rows are split by (env, version) on both sides so a staging-only version cannot read as a
  production regression. buildVersionCorrelation extracted to query/errorGroups.ts; unit
  76/76 (env separation, traffic-only rows, untagged labels, truncated + full coverage).

## 2026-11-21 07:48 AEDT - Actionable next steps on problems (this commit)

Now-page problem rows carry an honest next-step line derived from the monitor kind: error
alerts point at top error group -> matching trace -> version/env concentration (lead, not
proof); silence problems say check app+instrumentation if the service should be up, with the
explicit "Monitoring cannot see why data stopped - silence can mean idle, crashed, or
disconnected". Problem rows restructured (monitor link on the name, no nested-link whole-row).
Visually verified with a live firing error monitor + a silent service in one screen.
CI: 43f64b9 success (correlation comparability), bf9caf1 success.

## 2026-11-21 07:57 AEDT - REAL end-to-end onboarding journey verified (this commit)

Parent direction: prove the published onboarding path with a fresh app, not fixtures.
- GAP FOUND + FIXED: the published snippets referenced /downloads/monitoring-trace-0.1.0.tgz
  and monitoring_trace-0.1.0-py3-none-any.whl, but the server's downloads dir held only the
  agent binary - both URLs 404'd. Added scripts/pack-sdks.mjs (node tgz required; python wheel
  needs `pip install build`, loud warning when skipped, never silent) and wired it into
  build:selfhost as pack:sdks.
- Fresh org + fresh Node app at /tmp/e2e-app: `npm install http://127.0.0.1:4730/downloads/
  monitoring-trace-0.1.0.tgz` (exact published instruction), run with the published env vars
  + `node -r @monitoring/trace/init app.js`. App: plain http server, /ok and /fail (real
  recordException + winston error log, per the SDK README).
- Result: 55 real spans, service correctly "degraded" (13 errors in 55 operations, 23.6%),
  [Default] Errors in shop-api Alert; error group TypeError "user <n> not found" count=13
  (8+5 across two bursts, env prod, version 1.4.0), matched 13/13 with full coverage;
  version correlation prod/1.4.0: 13 errors / 55 operations; 5 winston logs joined by trace
  id (console.* is documented as not shipped - SDK README is honest).
- Trace view on a failing request shows the real stack pointing at app.js:10.
- Error-group detail now also returns relatedLogs (logs sharing a trace id with matched
  error spans, capped 10 traces/100 rows) with a "none" state that says none were ingested
  with those trace ids, not that nothing was logged.
Unit: 76/76. CI greens through 43f64b9.

## Python onboarding e2e + fast_flask exception capture (pending commit)
- Exercised the published Python setup against server :4730 (db e2e): pip-installed the wheel from the server's own /downloads URL into a fresh venv, ran a Flask app via `monitoring-run python app.py`.
- Found + fixed a real SDK gap: Flask converts app exceptions to 500s inside wsgi_app, so the lean fast_flask wrapper never saw them; error groups had empty type and no stack. Fix: patch Flask.handle_exception to record_exception + ERROR status on the active server span (ingest already maps exception events to error.type/message/stack).
- Verified live after fix: py-shop spans 29+13 across versions 2.0.1/2.0.2; Now shows degraded (6 errors in 29 ops, 20.7%); error group type=KeyError with real message; version correlation prod/2.0.2 = 3 errors/13 ops vs prod/2.0.1 = 0/29; 18 trace-joined related logs; real Python traceback stored in span meta (error.stack).
- Harness gotcha recorded: `monitoring-run python app.py` re-execs `which("python")`; the venv must be on PATH (i.e. activated) or the re-exec leaves the venv. Same behavior as upstream opentelemetry-instrument.
- Onboarding downloads guard (Misc.tsx): node/python tabs show a red warning when the packed tgz/whl is absent from /downloads. Build b18 green; visual check pending.
- Re-verified on current build: memberships 40/40 (memb2 db), quotas 34/34 (quota2 db, two-process).

## Guard fix + count reconciliation (pending commit)
- Downloads guard fix: the guard queried /api/downloads but the downloads router is mounted at the server root (unauthenticated, used by install.sh), so the query 404'd and the guard silently never rendered. First visual check caught it (vacuous-green guard). Fixed to fetch /downloads directly; both states then verified in a real browser: wheel present -> normal pip snippet, no false warning (guard-python-present.png); wheel absent -> warning + `pnpm run pack:sdks` as the only command, no copyable broken install command (guard-python-missing.png).
- Python README: documented that monitoring-run re-execs the `python` found on PATH, so the app venv must be activated (else the app starts uninstrumented and sends no spans).
- Count reconciliation (presenting Now beside version tables): Now is a sliding 5-minute per-service window over all entry spans (29 ops / 6 errors for py-shop at 08:04 AEDT, both error groups). The version-correlation table is per error group over a 7-day window: the KeyError group showed prod/2.0.2 = 3 errors/13 ops and prod/2.0.1 = 0/29 because the six 2.0.1 errors predate the fast_flask fix and sit in the separate "(no error type)" group. Different windows (5 min vs 7 days) and different units (service vs one group) - differences are legitimate and now stated beside the numbers.
- Readiness scope wording: verified onboarding journeys are exactly Node.js (winston log shipping) and Python Flask (fast_flask + standard instrumentor fallback). Django/FastAPI/other-framework support ships via the same distro+instrumentors and the generic OTLP endpoint but is NOT covered by a live journey; do not generalize the two verified journeys to "every framework".

## Exception incidents on the Now page (pending commit)
- New query/incidents.ts: buildIncidents (pure, unit-tested) + computeExceptionIncidents (bounded scan, limit 2000 error spans/24h, truncation flagged). /ui/now gains exceptions[] + exceptionsSupported (false on backends without error_groups - never reads as "no exceptions").
- Incidents surface: NEW badge when first seen within the hour (observation fact), error type, message, service, env list, occurrence count, first-seen time, endpoints ranked from the `resource` column (ingest normalizes op to "http.server.request"; route lives in resource - using `name` was a bug caught by live data), versions observed among matched spans (capped at 3 + overflow note).
- Wording boundary held: first-seen and observed versions are stated as separate facts; nothing claims an exception "started after a deploy" (no deployment-time evidence exists yet).
- Live validation-bar exercise on e2e (:4730): baseline checkout v3.0.0 (25 ok ops), restart as v3.0.1 with a new /checkout route raising ValueError. Zero config: Now showed service degraded (5 errors in 55 ops, 9.1%), default monitor ALERT, and the incident "NEW ValueError bad checkout payload - 5x, first seen 1m ago, versions 3.0.1, mostly in GET /checkout (5x), coverage 5/5". Screenshot now-problems.png. Unit 81/81.
- Harness notes: sessions are in-memory - re-login after every server restart (cookie name is `sid`); route decorators added to a Flask file must sit above the blocking app.run() call.

## Problems ranking/dedup + workflow status (pending commit)
- Ranking/dedup on Now: firing monitors and exception incidents merge into one recency-ranked list; a firing auto "Errors in <service>" monitor is absorbed into its incident row (badge + monitor link), so one failure no longer renders as two problems. Repeated No Data monitors collapse into one expandable "N services quiet" row with the guidance shown once. Next-step guidance renders on the first active row only.
- Workflow status (migration 13, problem_status): acknowledge/mute/resolve per monitor or error group via POST /ui/problems/status (org-scoped ref validation; 'open' clears). query/problemStatus.ts effectiveProblem() is the single source of display logic, unit-tested (7 tests incl. boundary: activity exactly at status time is not new).
- Boundaries held: workflow status never edits measured state (monitor rows, group counts untouched); resolved + new occurrences -> active again with REOPENED badge and "new occurrences after this was marked resolved", the human record preserved beside it; muted stays muted but flags "new activity since mute" inside the muted section.
- Verified live on e2e (:4730): resolve ValueError incident -> resolved section (by e2e@e2e.e2e); new /checkout error -> active + reopened, count 5->6. Negative controls: bad kind/status 400, unknown group 404, org-scoped ref check (monitor ref must belong to the org). Screenshot now-problems.png shows dedup, ranking, collapsed silence, single guidance row.
- Correction to earlier harness note: sessions are PG-backed (signed with SESSION_SECRET); the 401s came from a stale secret/cookie across restarts, not in-memory sessions.

## Cross-org problem-status probe + uptime checks (committed ba69f0f..6d7e4a7)
- Isolation suite (bench/security/isolation.js): genuine cross-org problem-status probe - org B POSTs status against A's error group and monitor (404), SQL verifies zero problem_status rows for B, A's own set/clear round-trips. Plus cross-org uptime: B cannot list/PUT/DELETE/run/status A's uptime check, A's row verified intact via SQL. 18/18 vs live e2e server; evidence bench/evidence/security/isolation-2026-11-21.json.
- Uptime probing: migration 15 (uptime_checks, uptime_results); lib/uptime.ts probe = webhook SSRF rules (http(s) only, no URL creds, private/loopback/link-local refused at literal AND resolution via makeSafeLookup; redirects followed, each hop re-validated, max 3; header-only reads; idle+total timeouts). Test-only private override MONITORING_UPTIME_ALLOW_PRIVATE=true is a separate flag from MONITORING_ALLOW_PRIVATE_WEBHOOKS - set it consistently across processes sharing a DB or results flap (observed live).
- jobs/uptime.ts loop: 5s tick, atomic claim via UPDATE...next_run_at bump + FOR UPDATE SKIP LOCKED, concurrency 4, 7-day result retention. Problem surfacing threshold SURFACE_AFTER_FAILURES=2; recovery measured (ok probe resets). Routes /ui/uptime CRUD + /run (org-scoped, MAX_CHECKS_PER_ORG=50, interval 30-3600s, timeout 1-30s, expect range 100-599); /ui/now gains uptime problems + uptimeSupported; /ui/problems/status accepts kind=uptime.
- Web: /uptime page (availability24h from measured samples only, null = "no probes yet", recent-probe bars), Now merges uptime rows with DOWN badge into the ranked list, nav entry. Also fixed missing --color-bad theme token (REOPENED/NEW badges were dead classes).
- LIVE-FOUND BUG: runUptimeCheck state UPDATE referenced $2-$7 while passing $1 -> PG rejected the statement ("could not determine data type of parameter $1"); results inserted but consecutive_failures never moved, so a dead target never surfaced. Unit tests missed it (no DB loop coverage); live loop watching caught it. Regression test added (runs runUptimeCheck against real schema; applies migrations[14] = uptime tables, NOT 13). Unit 96/96.
- Live e2e (server :4730 with MONITORING_UPTIME_ALLOW_PRIVATE=true, db e2e): flagless twin :4733 refused private target at create (400) - negative control. Self health check (http://127.0.0.1:4730/api/healthz) ok; Dead endpoint (http://127.0.0.1:1/) ECONNREFUSED; Now shows DOWN row after 2 failures; resolve -> resolved; next failing probe -> active REOPENED. Screenshots uptime-page.png, now-uptime.png sent to parent.
- CI: greens through 911442a; 6d7e4a7 dispatched.
- Harness: pkill -f 'PORT=X' does NOT match `env PORT=X node` processes - kill by pid from ss -ltnp. Health endpoint is /api/healthz (bare /healthz hits the SPA fallback). Two servers sharing a DB both run background loops (skip-locked prevents double-probing but either config probes).

## 2026-11-21 (afternoon): readiness claims, concurrency proof, nav, deploy markers (P1)

- df3ded9 uptime: fair claim ordering (per-org cap 5/tick within oldest-due-first global batch) + redirect-hop live refusal controls.
- a55d141 uptime: bench/uptime/concurrency.js - two real workers against one PG, 4/4: exclusivity (one result per check per interval across workers), fairness (small org not starved by big org's due backlog), oldest-due-first. Harness caught a missing next_run_at projection in the claim query before any claim was made; fixed same commit. Evidence: bench/evidence/uptime/concurrency-2026-11-21.txt.
- 6b1ace9 nav: primary Now/Services/Errors/Uptime; ADVANCED caption over Dashboards/Monitors/Metrics/Logs/Events/Infrastructure; Deploys absent until the feature landed; Now uses exact-match active state.
- HEAD deploy markers (P1): migration 16 service_versions(org_id, service, version, first_seen, last_seen); intake upserts first/last observation per (service, version) in the same fresh-spans transaction as error groups (retry-safe, cannot backdate). Deploy-evidence rule deployEvidenceFor in query/incidents.ts: the claim "first observed after deploy V" requires ALL of - untruncated scan, >=1 matched span, zero untagged matched spans, exactly one distinct version among matched spans, a service_versions row, and deploy first_seen STRICTLY before the group's first_seen (equal timestamps cannot be ordered: no claim). UI wording: "Timing observation, not proof of cause." /ui/now returns serviceVersions (latest first_seen per service) and Now shows "v<version> first seen <ago>" per service; incident footer explains the claim's gate.
- Unit: 108/108 (+9: deployEvidenceFor gate matrix incl. 6 negative controls, buildIncidents observation-state exposure, aggregateServiceVersions).
- Live e2e (db e2e, port 4730): Flask app as checkout-deploy v3.0.1 (traffic, no errors) -> restart v3.0.2, /ok first, then 5x /checkout ValueError -> /ui/now incident carries deployEvidence {version 3.0.2, deployFirstSeen 1795211685563 < firstSeen 1795211693571}, all 5 matched spans on 3.0.2, zero untagged. Live negative control: checkout-equal v4.0.0 whose FIRST span is the KeyError itself -> deploy record exists with first_seen == group first_seen -> claim withheld (deployEvidence null). Both verified via API and Now page screenshot (deploy-now.png).
- CI: greens through 6b1ace9 (a55d141 run covers df3ded9 as ancestor; df3ded9 itself had no dispatched run).

## 2026-11-21 (later): correction - version-first-observed timing, never deploy (parent review)

- Parent review: first observation of a service.version is not a deployment event; no guard
  matrix turns it into one. Corrected before any P2 work:
  - All deploy naming removed from UI/API/docs: deployEvidenceFor -> versionTimingFor;
    field deployEvidence -> versionTiming; service_versions described everywhere as a version
    OBSERVATION record. UI line: "all N matched spans in env <E> carry version <V>, first
    observed in <E> <ago>, strictly before this exception's first sighting.
    Version-observation timing, not a deployment record and not proof of cause."
  - ENVIRONMENT SCOPE added (migration 16 rebuilds service_versions with env in the PK;
    hours-old env-less rows dropped - they could not be honestly attributed). New gate:
    matched spans must sit in exactly ONE env, and the version's first_seen is looked up
    for (service, env, version). A staging-first observation can no longer back a prod line.
  - PRODUCT-PLAN.md amended: true deploy markers (recorded deployment evidence) are unbuilt
    and listed separately; validation bar reworded without "deploy".
- Unit 110/110 (+2: staging-record negative, buildIncidents env exposure).
- Live re-verified (db e2e): positive checkout-v2 (prod, v3.0.1 traffic -> v3.0.2 errors):
  versionTiming {3.0.2, prod, versionFirstSeen 1795212085510 < firstSeen 1795212093517}.
  Negative checkout-xenv: v5.0.0 observed in staging FIRST (1795212113128), prod error is the
  version's first prod span (first_seen == group first_seen) -> versionTiming null. Without
  env scoping the staging row would have passed strict-before and produced a false claim.
  Screenshot version-timing-now.png.

## 2026-11-21: Now-page density fix (parent review)

- Parent: screen too text-dense; keep evidence/caveats accessible without a diagnostic
  paragraph per row. Restructure (web only, no API change): incident/monitor/uptime rows
  are one line of measured facts + workflow actions; all evidence (envs, versions observed,
  full version-timing sentence with caveats, endpoints, next-step guidance) moves into a
  collapsed per-row "Evidence & caveats" / "Next step" disclosure. Version timing, when the
  rule passes, keeps a compact inline chip ("v3.0.2 · prod · observed before first sighting")
  whose hover title carries the full sentence including "not a deployment record, not proof
  of cause". Measured vs workflow distinction preserved inline (counts/first-seen measured;
  acknowledge/mute/resolve + resolved-by workflow).
- Screenshots: dense-now.png (collapsed), dense-now-open.png (one disclosure open).

## 2026-11-21: validation-bar run (empty account to first useful answer)

- Fresh server (4731) + empty db (valrun); real path: setup form -> Connect your app
  (waiting state) -> API key via the UI's own endpoint -> shop app v1.0.0 healthy -> v1.1.0
  with a /checkout bug. Now page answered with zero configuration: ALERT NEW ValueError
  with auto-created monitor linked, version-timing chip (v1.1.0 · prod), honest low-traffic
  service note. Connect page flipped to "Receiving data from shop-api".
- Stopwatch 190s first-load-to-answer (scripted path; human slower). Evidence:
  bench/evidence/validation-2026-11-21/ (4 screenshots + README with API confirmation).

## 2026-11-21: onboarding UI-path verification + two fixes (parent review)

- UI-only key path verified on the fresh org (visible controls only): Organization Settings
  -> API Keys -> New Key -> masked banner (eye toggle reveals, copy writes the full key -
  source-verified KeyCell; live clipboard read blocked twice by sandbox Chrome instability,
  disclosed). Leave-and-return: banner gone, server list only ever returns hints. Shown-once
  contract holds. No key value in any screenshot (banner masked by default).
- FIX 1: install command had no copy control (long two-line command, manual selection across
  an overflow-x scroll). Added a copy button on the onboarding snippet (full command, one
  click, confirmation tint).
- FIX 2: narrow viewport was broken - 200px sidebar never collapsed, squeezing content into
  half a phone screen. Sidebar is now hidden below md behind a hamburger top bar; opens as
  an overlay drawer with backdrop, closes on navigation and backdrop tap. Desktop unchanged.
  Verified at 390x844: Now (chips wrap, disclosures collapsed), onboarding, drawer, and
  drawer-closes-after-nav.

## 2026-11-21: responsive polish round 2 (parent review) + clipboard runtime proof

- 390px header: fixed-width centered search overlapped account/logout -> search is now a
  flex item below md (absolute-centered only md+); kbd hint hidden on small screens.
- Services row: status note no longer truncates on narrow screens (flex-wrap; note takes
  full basis below sm, version chip wraps under it).
- Caveat footer: methodology paragraph replaced by one essential line ("First-seen and
  versions are observation facts ... never deploy claims or proof of cause") plus a "How
  incidents are measured" disclosure holding the full text.
- Clipboard runtime proof (previously open): writeText-spy harness - snippet copy button
  writes the full 3-line command (npm install + env line); key banner copy writes the full
  32-hex key. (First harness run mis-sliced the spy array after navigation and reported
  empty; fixed and re-verified. Test keys accumulate only in the disposable valrun org.)
- Verified 390x844: header clean, Services status readable, footer one line + disclosure;
  desktop 1440 unchanged.
