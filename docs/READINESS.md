# Readiness

What is verified, and what is not. Every claim below is backed by a runnable test or a recorded run;
anything without one is listed under Not yet verified. Dates are 2026-11-20 (Sydney). Evidence lives in
`bench/evidence/` and the benches under `bench/` are rerunnable.

## Verified

**Identity and organizations**
- Password sign-in, first-run setup, invites, per-organization roles, member removal, last-admin guard,
  cross-organization denial: `bench/security/memberships.js` 40/40 (fresh database each run).
- OIDC single sign-in: discovery, PKCE, id_token signature (RS256/JWKS) and iss/aud/exp/iat/nonce
  verification, (issuer, subject) identity binding, (issuer, external org id) membership binding,
  fail-closed synchronization of provider-derived grants (local grants untouched), issuance-time ordering
  with fail-closed ties, 12h absolute SSO session cap, existing sessions converge on revocation:
  `bench/security/oidc.js` 38/38 including adversarial cross-issuer/same-name and replay cases.
- Session storage uses timestamptz (migration 8); a timezone bug that silently shortened sessions is
  fixed and covered by the OIDC bench.

**Data isolation and quotas**
- Cross-organization data isolation at the query layer, verified with two-process Postgres enforcement:
  M5 audit (docs/AUDIT.md).
- Backup/restore: restore test EXECUTED 2026-11-21 (bench/evidence/restore-test-2026-11-21.json):
  full-database pg_dump -> pg_restore into an empty database, exact row-count equality on all 23
  tables (915,675 spans, 499,686 logs) plus spot checks. This line previously listed the restore
  test as done before it had ever been run; that was wrong and is corrected here - the first real
  execution is the 2026-11-21 run. Not covered: PITR, incremental, non-empty target, cross-version.
- Per-organization quotas (points/logs/spans per day, series cap, per-minute ingest bytes) enforced
  atomically in Postgres, safe across multiple server processes; 21 quota checks plus UI visibility of
  intake drops.

**Intake, scale and resilience (server side)**
- Bounded scale run (60s, 20 hosts, 10 services, 50 traces/s, 2k cardinality): 19,281 spans, 3,191 logs,
  12,640 counter points sent with 0 errors; stored counts match exactly for spans and logs (metric points
  stored >= sent because host gauges share the run tag; no loss). Intake p50 10ms, p99 73ms.
- Server-only resilience (`bench/resilience/server-only.js`, app -> server -> Postgres):
  - baseline: 6,000/6,000 spans and 3,000/3,000 logs stored, zero duplicates;
  - server down 15s (inside the client libraries' 30s retry budget): zero span loss, zero duplicates,
    51/3,000 logs lost (stock OpenTelemetry log exporter retries less - known limitation);
  - Postgres fast restart during load (11,000 spans + 5,500 logs at 100 spans/s): zero loss, zero
    duplicates, fresh data visible 14ms after recovery (pg pool error handling, fixed 2026-11-20);
  - server down 45s at 100 spans/s (past the 30s client retry budget): 52/11,000 spans lost (0.47%),
    zero duplicates, 1,880/5,500 logs lost (stock OTEL log exporter), fresh data 13ms after recovery.
    This is measured app-side loss without the agent; the agent layer's effect is now measured
    (agent-topology suite below: the measured outages were fully absorbed by the agent disk queue).
- Alerting journey (dashboard -> alert -> webhook -> recovery): 14/14.
- Unit suite: 63/63.

**Security of key material**
- API keys are shown once at creation and never returned by routine API/UI responses; install commands
  use a shell-safe placeholder or a freshly created key embedded once in-page. Revocation takes effect at
  intake immediately (verified: intake returns 403 after revoke).
- `/install.sh` content is sha256-pinned to the hosted artifact.

## Not yet verified (explicit gaps)

- **Recovery, app -> agent -> server, measured 2026-11-21** (run wo501, 6/6 scenarios,
  all counts DB-verified per service; evidence bench/evidence/recovery/agent-2026-11-21.json).
  Harness strips MONITORING_URL from the generator and asserts stored rows carry the agent
  resource identity (0 topology violations). Agent: otelcol-contrib disk queue; instrumentation
  delta vs generated default config is observe-only (verified by diff). SDK: RetryingLogExporter
  + 65536-entry log queue (commit e4ef049). Results, spans/logs stored vs sent, 0 duplicates in
  every scenario: baseline 18000/18000 + 9000/9000; backend_outage 60s 18000/18000 + 9000/9000
  (fresh 11.8s after recovery, drained 25.2s); agent_restart SIGTERM 18000/18000 + 9000/9000;
  db_restart 18000/18000 + 9000/9000; long_outage 240s at 600 spans/s 180000/180000 + 90000/90000
  (fresh 26.0s, drained 0.4s); agent_kill_pending (SIGKILL with 16MiB/8MiB queue files pending,
  5867/18000 spans stored at kill) 18000/18000 + 9000/9000 after restart. Stage counters over
  566 scrapes: max queue depth 581/1000 requests, zero receiver refusals, zero exporter
  send/enqueue failures. Remaining caveats: zero duplicates observed does not prove the queue
  never double-delivers (server intake has no idempotency keys; semantics are at-least-once);
  the direct-topology rerun with the fixed SDK is done
  (direct-fixed-2026-11-21.json); the shipped default agent config acceptance run is done
  (acceptance-2026-11-21.json, run cbazi: same 6 scenarios via the install.sh onboarding config,
  all zero-loss, exact counts in final DB state). Scope: zero loss in these measured scenarios is
  not a universal zero-loss guarantee.
- **Recovery, app -> server direct, measured 2026-11-20** (evidence
  bench/evidence/recovery/app-direct-2026-11-20.json, all counts DB-verified). A harness wiring bug
  (MONITORING_URL leaking to the generator, which the SDK config reads as "direct mode") made the
  first full-stack run bypass the agent; the rerun above adds the agent-mediated measurements.
  Direct-mode results with the pre-fix SDK:
  - baseline and Postgres fast restart: zero loss, zero duplicates;
  - backend_outage 60s with pre-fix SDK: 617/18,000 spans and 3,888/9,000 logs lost, entirely
    app-side vs a dead server: the stock OTLP log exporter drops a batch on the first transport
    error; the patched span exporter's 30s retry covers all but the kill window. Fixed in
    sdks/node/lib/retry-log-exporter.js + larger log queue (commit e4ef049); validated direct-topology
    2026-11-21 (direct-fixed-2026-11-21.json): same fault loses 100 logs (was 3,888) and 616 spans
    (was 617). Attribution: app-side export errors appear in the generator log only during the
    outage window and the lost count matches the outage-minus-30s-retry-budget traffic, consistent
    with retry-budget expiry; the 65,536-entry log queue was not the binding constraint at 9,000
    logs. Span-path cause not independently confirmed by a stage counter.
  - long_outage 240s at 600 spans/s with pre-fix SDK: bounded loss (56,078/180,000 spans,
    19,931/90,000 logs stored, 0 duplicates) dominated by app-side buffering limits. With the fixed
    SDK: 59,887/180,000 spans and 83,511/90,000 logs stored (log loss -90.7%), 0 duplicates.
    Span loss is consistent with in-memory queue capacity plus retry expiry (lost volume roughly
    equals outage-window traffic minus the observed buffering), but no stage-level span counter
    separates the two causes; direct-mode residual loss remains a readiness limitation.
- **SSO revocation timing**: bounded by the 12h absolute session TTL plus issuance-time ordering; this is
  an explicit exposure limit, not prompt revocation. A fresh callback from an old provider login renewing
  stale claims is covered by iat-ordering + fail-closed ties, but identity-provider-specific behaviors
  (back-channel logout, per-provider claim freshness) are untested - no live IdP was available.
- **Production hardening**: no HTTPS terminator, rate limiting at the edge, HA Postgres, or multi-node
  deployment has been set up or tested; no paid hosting or live deployment is authorized.
- **Multies bridge**: design documented in docs/MULTIES-BRIDGE.md (B1 workspace API-key binding ready on
  this side, B2 OIDC needs a small Multies write); nothing is wired to a live Multies instance.
