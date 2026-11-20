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
