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
