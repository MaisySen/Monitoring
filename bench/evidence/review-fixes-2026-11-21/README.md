# Focused F1-F4 fix packet

Baseline reviewed source: `ed300a07e098c56e45b907f613e0751fc8ba2dca`.
Product fixes: `cb7aab8` (F1/F3), `92dd6d2` (F2/F4 and test-only docs).
The attached Git bundle and its SHA256 manifest identify the exact evidence/test commit.
This packet requests focused re-review. It is not acceptance or permission to enable retries.
`MONITORING_METRICS_RETRY` stays OFF by default; the opt-in is TEST-ONLY.

## Changes and direct evidence

### F1: metadata effects after a header-bearing batch

The successful PG claim path now refreshes `metric_series.last_seen` in the same transaction as
points and quota, then performs normal host/app discovery after commit. Warm cached series no
longer depend on the series-creation upsert to stay query-visible. Batch traffic refreshes all
admitted series ids per committed batch, without publishing a throttled touch in memory before
commit. This costs a metadata update per admitted batch, a deliberate correctness trade-off for
this test-only path. The non-batch path retains its existing refresh throttle.

`test/fixtures/batch-review-child.ts` mounts the production intake router, auth middleware and
telemetry/query router against a real scratch PG database. It warms caches with one header batch,
advances the process clock one hour, and ingests a new header batch. It asserts:

- `/api/v1/query` returns the fresh metric value 7, using the real series-visibility filter;
- `/api/ui/metrics` reports the metric with fresh `last_seen`, as dashboard discovery consumes it;
- `/api/ui/hosts` reports the fresh host with its metric app link.

These are HTTP/query assertions, not point-row counts alone. No browser dashboard pixel check was
performed, and no UI code changed. Against original ed300a0 source, the same query assertion fails.
See `f1-original-source-fails.log` and `focused-http-pg-pass.log`.

### F2: duplicate success encoding

Duplicate success now calls the same `encodeEmptyResponse(contentType)` helper as ordinary
success. The test sends JSON and a non-empty protobuf metrics request through actual intake.
Both first and duplicate protobuf responses have `application/x-protobuf` and a zero-byte valid
empty service response. JSON duplicate response is `{}` with `application/json`. Stored protobuf
metric sum is 11 after both sends, not 22. Temporarily restoring the old JSON ACK causes the test
to fail. See `f2-json-ack-fails.log` and the focused pass log.

### F3: quota and authoritative claim

Point-quota admission now runs AFTER winning the transactional claim, using that same transaction.
Concurrent duplicate losers do not charge point quota; failed point insertion rolls quota and
claim back together. Quota refusal also leaves no claim, allowing retry when capacity becomes
available. Non-batch and ClickHouse point-quota paths remain outside this PG batch protocol.
Request-byte rate limiting still applies to every HTTP request, including duplicates. This fix
is not an exemption from network intake limits.

Tests force contention with a delayed claim insert, with point quota set to exactly one. Three
same-id deliveries produce one ingest and two duplicates; daily point usage equals one. A forced
point-insert exception leaves usage unchanged and no claim; a later successful retry charges once.
A quota refusal leaves no claim and the same id succeeds after raising the test quota. Restoring
preclaim quota admission fails the quota-rollback assertion. See `f3-preclaim-quota-fails.log`.

### F4: deliberate strict identity contract

No canonicalization was added. Identity remains the SHA256 of RAW `req.body`, including compressed
wire envelope bytes. Decompression reads without changing that body. Exact gzip bytes retry with
200. Changing only gzip mtime bytes, keeping decompressed content identical, returns 409 under the
same id. Re-encoding/recompressing clients must use a new id when their wire bytes change. The
route comment and SDK README now state this contract. The test preserves it deliberately rather
than silently broadening it to semantic equivalence.

## Reproduction and results

From `artifacts/api-server`, with a scratch-database-capable `DATABASE_URL`:

```sh
node --import tsx --test test/batch-review.test.ts
npm test
```

- Final full API-server suite: 113/113 pass, exit 0, `server-113-pass.log`.
- Focused F1-F4 real HTTP/PG test: pass, `focused-http-pg-pass.log`.
- Unchanged SDK behavior suite: 28/28 pass, `sdk-28-pass.log`.
- DB declarations built with `pnpm exec tsc -b lib/db`; API typecheck and server build then pass,
  exit 0, `typecheck-build.log`. Earlier missing-declaration diagnostics were not a clean check.
- The failing sensitivity logs are intentional negative controls, not unresolved final failures.
- Previous nine-check local regression and binary provenance are historical ed300 packet evidence,
  not re-verified against this fix in this packet. CI for this source is tracked separately.

## Limits retained for review

Extra retries remain default OFF, opt-in TEST-ONLY. Older servers and ClickHouse do not implement
this dedup protocol. Server retention and client age-cutoff compatibility remain operator
responsibility. Already-in-flight requests can complete after the age cutoff. Clock rollback,
configuration validation, callback/shutdown edge cases, and other SDK concerns are not certified
by these server-focused fixes. No production-readiness conclusion follows from the passing tests.

Host/app writes still occur after the points transaction, as on the normal path. Their failure
could leave metadata incomplete after points committed; a duplicate is not a metadata-repair
operation. This packet restores parity and the reproduced query-discovery case, not atomicity of
all side effects across the product.
