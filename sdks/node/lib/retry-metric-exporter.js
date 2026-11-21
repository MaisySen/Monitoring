'use strict';
// Retrying wrapper for the stock OTLP metric exporter. OPT-IN ONLY (MONITORING_METRICS_RETRY=true)
// until server-side intake idempotency is implemented and verified: see "Ambiguous delivery" below.
// Not the default: a wrong double-count is worse than a dropped batch.
//
// The stock OTLPMetricExporter reports a batch as failed on the first transport error and the
// PeriodicExportingMetricReader then DROPS it - a keep-alive reset race, a brief server outage or
// an agent backpressure window silently loses every metric point generated in it. Spans
// (lib/span-exporter.js) and logs (lib/retry-log-exporter.js) already retry; metrics remain the
// weak signal when this is off.
//
// This wrapper re-exports the SAME batch with exponential backoff (250 ms .. 5 s, jittered) for
// up to MONITORING_EXPORT_RETRY_SECONDS (default 30), mirroring the span/log paths. Non-retryable
// HTTP statuses (4xx other than 408/429) fail immediately. Retries stop once the exporter is
// shutting down so a process exit is never held up.
//
// Considered limit: unlike logs there is no disk spool here. Metric batches are aggregated
// deltas/cumulatives whose serialization for spooling is lossy; the retry window covers the
// observed transient classes (reset race, restart seconds). A longer outage still loses metrics.
//
// Ambiguous delivery: a retry after the SERVER stored the batch but the response was lost
// (e.g. reset mid-response) lands the same points twice. Unlike spans
// (intake dedups on (org_id, trace_id, span_id)) metric_points has no (series_id, ts)
// uniqueness guard. Against the actual query path (artifacts/api-server/src/query/metrics.ts):
// avg/min/max/last rollups are unaffected by an identical duplicate point, but ANY sum or
// count rollup double-counts it - including default `count`-type metrics (timeAgg sum) and
// DELTA sums. There is no aggregation under which duplicates are universally safe, which is
// why this wrapper is opt-in until intake idempotency exists. A server-side idempotent
// insert (batch-level idempotency key, not a naive (series_id, ts) uniqueness that would
// drop legitimate same-timestamp samples from distinct batches) is the follow-up.
const SUCCESS = 0;

function statusOf(error) {
  if (!error) return 0;
  const c = error.code ?? error.statusCode;
  // Network errors carry string codes (ECONNRESET, ETIMEDOUT, ...): no numeric status, retryable.
  return typeof c === 'number' ? c : 0;
}

class RetryingMetricExporter {
  constructor(inner, opts = {}) {
    this.inner = inner;
    this.retryMs = Number(opts.retrySeconds ?? process.env.MONITORING_EXPORT_RETRY_SECONDS ?? 30) * 1000;
    this.stopped = false;
  }
  export(metrics, resultCallback) {
    if (this.stopped) return resultCallback({ code: 1, error: new Error('exporter shut down') });
    const deadline = Date.now() + this.retryMs;
    const attempt = (n) => {
      this.inner.export(metrics, (res) => {
        if (res.code === SUCCESS) return resultCallback(res);
        const status = statusOf(res.error);
        const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        const remaining = deadline - Date.now();
        if (!retryable || this.stopped || remaining <= 0) return resultCallback(res);
        const delay = Math.min(Math.min(5000, 250 * 2 ** n) * (0.8 + Math.random() * 0.4), remaining);
        setTimeout(() => attempt(n + 1), delay);
      });
    };
    attempt(0);
  }
  selectAggregationTemporality(instrumentType) {
    return this.inner.selectAggregationTemporality
      ? this.inner.selectAggregationTemporality(instrumentType)
      : 0; // AggregationTemporality.CUMULATIVE fallback; the wired reader passes DELTA via the inner exporter
  }
  async shutdown() {
    this.stopped = true;
    return this.inner.shutdown();
  }
  async forceFlush() {
    return this.inner.forceFlush ? this.inner.forceFlush() : undefined;
  }
}

module.exports = { RetryingMetricExporter };
