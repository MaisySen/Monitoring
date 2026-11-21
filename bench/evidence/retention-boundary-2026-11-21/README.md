# Retention boundary vs retry age: measured (2026-11-21)

Question: can a client retry ever arrive after its intake_batches claim row has been swept, and
what happens then? Answered by measurement, not inference, against the local PG server (valrun,
port 4731, PG 14 on 5433, develop 5ee8190).

## Client side: actual maximum retry age

Harness: /tmp/sdk-e2e/retry-age.js (real OTLPMetricExporter + RetryingMetricExporter +
MetricBatchTracker, library defaults: 30 s retry budget per batch, pending queue 10, transport
timeout 10 s). All sends held by a wire server; 12 batches fired (1 active + 10 pending + 1
overflow); every budget exhausted; per-batch age = last wire send time - export() call time.

Results in `retry-age.json` (raw harness output). Measured with all 12 batches fired in one
synchronous burst (worst case for backlog): 10 admitted, overflow failed fast with
"metric retry queue full (10); dropping batch". Note: under a synchronous burst the admission
check counts the not-yet-drained active batch against the queue, so burst capacity is 10 total,
not 10 pending + 1 active; production exports arrive spaced by the reader and are unaffected.
Each admitted batch made 3 transport attempts (10 s timeout each) inside its 30 s budget, batches
drained strictly serially (~30.7 s each), and the oldest batch's last send landed 297.3 s (~5 min)
after its export() call. Full backlog utilization (1 active + 10 pending, spaced arrivals) bounds
the age at ~11 x 30.7 s ~ 5.6 min. Either figure is ~0.2% of the 48 h retention boundary.

## Server side: the retention boundary

Setup: a real SDK batch (`rtn.boundary` counter, +1) captured verbatim by a logging proxy
(/tmp/sdk-e2e/capture-proxy.js); the exact bytes re-sent with curl carrying the same
x-monitoring-batch-id. Batch id b52e5d80-7340-4092-80d4-f9967f69f61b. Claim-row ageing done by
UPDATE on received_at; sweeps invoked directly (sweepIntakeBatches) against the live DB.

| Step | State | Sweep deleted | Resend result | Stored points |
|------|-------|---------------|---------------|---------------|
| 1 | fresh claim row | - | 200, deduped | 1 (unchanged) |
| 2 | row aged 47.9 h | 0 | 200, deduped | 1 (unchanged) |
| 3 | row aged 48.1 h | 1 | 200, RE-INGESTED | 2 (boundary crossed) |
| 4 | new row aged 48.1 h, swept, 3 concurrent resends | 1 | 200 x3, exactly one ingests | 3; exactly 1 claim row |

Findings:

- The dedup guarantee ends precisely at MONITORING_BATCH_RETENTION_HOURS (default 48): a resend
  after the sweep re-ingests and double-counts. This is the documented boundary, now measured at
  both sides of it (47.9 h holds, 48.1 h crosses).
- After a post-sweep re-ingest, concurrent resends of the same id still serialize through the
  claim transaction: exactly one re-ingests, the others dedup, exactly one claim row results.
- Sweep cadence (code-level fact, not measured): startRetentionLoop runs sweepIntakeBatches on an
  hourly setInterval with no startup run (artifacts/api-server/src/jobs/monitors.ts), PG only;
  ClickHouse enforces retention by table TTL and its intake path ignores the batch header entirely.

## Conclusion: observed defaults vs the enforced gate

The 297.3 s figure is a SAMPLE under observed defaults, not a maximum: host suspension, event-loop
stalls, operator-set budgets/queue sizes, and slow in-flight sends all sit outside any sample. The
actual guarantee is the enforced wall-clock gate added after this measurement (commit with
MONITORING_EXPORT_MAX_AGE_SECONDS, default 600 s): every batch is stamped at enqueue and the
wrapper refuses to START a send past the cutoff - checked at activation and before every attempt,
so a batch queued across a suspend or resumed late from backoff expires instead of sending
(wire-tested: stale pending batch sends zero times; late backoff resume sends nothing). Two limits
stay explicit: the client cannot verify the server's retention setting, so max age << retention
(defaults 10 min vs 48 h) remains OPERATOR RESPONSIBILITY, not enforced compatibility; and a send
already in flight when the host suspends can still complete after the cutoff - the gate bounds
send initiation, not completion. No 48 h run was performed and no universal maximum is claimed.
