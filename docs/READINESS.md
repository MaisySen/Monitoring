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
  M5 audit (docs/AUDIT.md) and restore test (real backup -> restore -> data checks).
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
    This is measured app-side loss without the agent; what the agent layer changes about it is untested
    here (no agent binary - see gaps).
- Alerting journey (dashboard -> alert -> webhook -> recovery): 14/14.
- Unit suite: 63/63.

**Security of key material**
- API keys are shown once at creation and never returned by routine API/UI responses; install commands
  use a shell-safe placeholder or a freshly created key embedded once in-page. Revocation takes effect at
  intake immediately (verified: intake returns 403 after revoke).
- `/install.sh` content is sha256-pinned to the hosted artifact.

## Not yet verified (explicit gaps)

- **Recovery, app -> server direct, measured 2026-11-20** (evidence
  bench/evidence/recovery/app-direct-2026-11-20.json, all counts DB-verified). A harness wiring bug
  (MONITORING_URL leaking to the generator, which the SDK config reads as "direct mode") made the
  first full-stack run bypass the agent; the agent-mediated rerun with a topology assertion in the
  harness is in flight. Direct-mode results:
  - baseline and Postgres fast restart: zero loss, zero duplicates;
  - **backend_outage 60s: FAILING GATE** - 617/18,000 spans and 3,888/9,000 logs lost, entirely
    app-side vs a dead server: the stock OTLP log exporter drops a batch on the first transport
    error; the patched span exporter's 30s retry covers all but the kill window. SDK fix in flight
    (sdks/node/lib/retry-log-exporter.js + larger log queue), to be validated in both topologies;
  - long_outage 240s at 600 spans/s: bounded loss (56,078/180,000 spans, 19,931/90,000 logs stored,
    0 duplicates) dominated by app-side buffering limits;
  - the agent-mediated scenarios (agent restart, ungraceful agent kill with a pending disk queue,
    server outage absorbed by the agent) have NO valid measurements yet.
- **SSO revocation timing**: bounded by the 12h absolute session TTL plus issuance-time ordering; this is
  an explicit exposure limit, not prompt revocation. A fresh callback from an old provider login renewing
  stale claims is covered by iat-ordering + fail-closed ties, but identity-provider-specific behaviors
  (back-channel logout, per-provider claim freshness) are untested - no live IdP was available.
- **Production hardening**: no HTTPS terminator, rate limiting at the edge, HA Postgres, or multi-node
  deployment has been set up or tested; no paid hosting or live deployment is authorized.
- **Multies bridge**: design documented in docs/MULTIES-BRIDGE.md (B1 workspace API-key binding ready on
  this side, B2 OIDC needs a small Multies write); nothing is wired to a live Multies instance.
