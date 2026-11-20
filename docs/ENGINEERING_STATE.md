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
