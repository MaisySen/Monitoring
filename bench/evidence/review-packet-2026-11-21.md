# Review packet: metric retry + intake batch idempotency (2026-11-21, develop 47fa01e)

Everything below is committed in-repo; nothing rests on scrolled-off terminal output. This packet
makes NO product-ready claim. The metric retry wrapper remains OPT-IN (`MONITORING_METRICS_RETRY=true`,
default OFF) pending reviewed end-to-end safety; this packet is the review input, not the approval.

## Scope and explicit non-goals

- ClickHouse intake is unchanged: it ignores `x-monitoring-batch-id`; behavior there is exactly as
  before the header existed (no dedup, duplicates possible on retry). Verified unchanged, not safe-by-default.
- Servers older than migration 20 ignore the header the same way. The header is strictly additive.
- No 48-hour run was performed; no universal maximum retry age is claimed (see "Sample vs gate").
- Retention config compatibility (client max age << server retention) is operator responsibility;
  the client cannot verify the server's setting.
- Repo stays public until fully built (owner instruction); no deployment, release or spend.

## Component inventory (each its own commit)

CI is green through 5ee8190. The last two rows are evidence/doc commits whose runs were in
progress at packet time (both dispatched; check run status at review time — a red run there would
be infrastructure noise, as neither changes product code beyond the SDK gate in 47fa01e, whose
local suites are 27/27).

| Commit | Concern | CI |
|--------|---------|----|
| 4887a32 | keep-alive race boundary evidence | success |
| 9639dd6 | RetryingMetricExporter (initial) | success |
| 9a67a9f | ambiguous-delivery doc + forceFlush/post-shutdown tests | success |
| 5667057 | retry made opt-in; gauge claim corrected (avg/min/max/last tolerate duplicates; sum/count double-count) | success |
| 82d070d | server batch idempotency (migration 20) | success |
| 26b294c | DB-backed idempotency tests (112/112 api-server) | success |
| 7e56cf8 | client MetricBatchTracker (one UUID per batch) | success |
| 35847ae | nine-check regression evidence log | success |
| 5ee8190 | exporter serialization mutex + wire tests | success |
| 0516c2b | retention boundary + retry-age evidence | in progress at packet time |
| 47fa01e | enforced wall-clock max batch age | in progress at packet time |

Correction on record: the stock exporter is NOT first-error-drop — otlp-exporter-base 0.301.1 has a
built-in RetryingTransport (5 attempts, 1s..5s backoff, inside the export timeout). The wrapper
extends the horizon; it does not introduce retry where none existed. Mechanism facts verified in
dependency source: payload serialized once per export call; headers callback invoked per HTTP send
(also wire-verified); PeriodicExportingMetricReader serializes exports only until its
callWithTimeout fires, then can orphan an in-flight export.

## Binary provenance (re-verified live at packet time)

- CI run 44872464276, head_sha 5667057 (API-verified), conclusion success; artifact "agent" id
  14694188993, unexpired, 136,285,600 bytes.
- `agent/dist/`: `sha256sum -c SHA256SUMS` OK for all five entries (4 binaries + notices).
- `git diff 5667057..develop -- agent/` is empty: the binaries are source-matched to current develop.
- `scripts/pack-sdks.mjs` run; the server serves these downloads (covered by the nine-check log).

## Evidence index

1. Nine-check regression: `bench/evidence/regression-2026-11-21/run-all-9of9-valrun.log` —
   9/9 PASS locally against the valrun instance, pipefail, exit 0, per-check output preserved.
2. Keep-alive race: `bench/evidence/soak-2026-11-21/RESET-MECHANISM.md` (recalibrated: finite
   samples never prove zero; hardening moves the boundary) + `boundary-scan-2026-11-21-pm.raw.jsonl`
   (race reproduces at 15s/65s keepAliveTimeout; original six soak resets remain unknown-outcome).
3. Server idempotency live verification: `bench/evidence/soak-2026-11-21/batch-idempotency-live-2026-11-21.md`
   (dedup, 409 on changed content, distinct batches preserved, 5-way concurrency exactly-once,
   no-header back-compat, empty-body edge documented as client-bug 409).
4. Batch-id overlap hazard: `bench/evidence/batch-id-2026-11-21/` — pre-fix wire log shows batch A's
   resent payload carrying batch B's id (4 pass/2 fail); post-fix 6/6; with the age gate 8/8
   (`wire-tests-age-gate.log`). Fix: exporter-side serialization, id at activation, bounded queue,
   shutdown drain.
5. Ambiguous delivery (lost response after commit): proxy drops the server's committed response
   once, real SDK with retry on. Run three times (pre-mutex, post-mutex, post-age-gate): server
   dedups every time — exactly one stored point (value 1) and one claim row per run (valrun PG,
   positive stored-value assertions via psql).
6. Retention boundary: `bench/evidence/retention-boundary-2026-11-21/` — resend dedups with a fresh
   claim row and at 47.9h; at 48.1h the sweep has deleted the row and the resend RE-INGESTS
   (points 1->2); post-sweep, 3 concurrent resends serialize to exactly one ingest, one claim row.
   Sweep cadence (hourly setInterval, no startup run, PG-only) is recorded as a code-level fact.
7. Retry age: same directory, `retry-age.json` — sample 297.3s under defaults is explicitly NOT a
   bound; the enforced gate is MONITORING_EXPORT_MAX_AGE_SECONDS (default 600s), checked at
   activation and before every attempt. Residual: in-flight send completion across suspension.

## Known limits (accepted, documented in code comments)

- No spool: an outage longer than the per-batch retry budget (or process exit) loses metrics batches.
- An already in-flight send can complete after the age cutoff if the host suspends mid-request.
- Empty metrics body claims its batch id; a later real payload under the same id gets 409 (client bug shape).
- SDK unit suites: api-server 112/112, node SDK 27/27 (19 unit + 8 wire).
- Unverified elsewhere (outside this packet): systemd/default install path; multi-hour soak needs a
  stable host; local Go agent build infeasible in this sandbox (CI artifacts cover it, provenance above).
