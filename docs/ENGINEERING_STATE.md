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
- pnpm audit clean (prod + full). scripts/backup.sh + scripts/restore.sh committed, RESTORE TEST NOT YET RUN.
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
