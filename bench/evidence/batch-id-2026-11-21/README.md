# Batch-id overlap hazard: demonstration and fix evidence (2026-11-21)

Concern under test: the batch id must follow the exact immutable batch across every resend, not
the exporter's current global state. PeriodicExportingMetricReader's callWithTimeout can orphan an
in-flight export while RetryingMetricExporter keeps retrying; the next collection then begins a new
export. Pre-fix, that flipped the shared id cell mid-retry.

- `wire-tests-prefix.log` - test/batch-tracker-wire.test.js run against the PRE-FIX exporter.
  Overlap test fails: send 2 (batch A's payload, still being resent) carried batch B's freshly
  minted id. On a deduping server that misattributes A's points to B's claim; on any server it
  breaks the one-id-per-batch invariant. 4 pass / 2 fail, exit 1.
- `wire-tests-postfix.log` - same tests against the fixed exporter (internal serialization:
  one active batch, id taken at activation, bounded pending queue). 6/6 pass, exit 0.

Fix: RetryingMetricExporter serializes exports (queue, one active), calls tracker.beginBatch()
only when a batch becomes active, bounds the pending queue (MONITORING_EXPORT_RETRY_QUEUE,
default 10; overflow fails fast so the reader drops that batch as with any failed export), and
fails pending batches on shutdown so exit is never held up.

Live re-verification after the fix: the ambiguous-delivery E2E (proxy drops the server's committed
response once) still dedups server-side - exactly one stored point (value 1) and one intake_batches
claim row for the run at 17:06 AEDT against the local PG server (valrun).
