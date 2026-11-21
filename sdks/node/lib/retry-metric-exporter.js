'use strict';
// Retrying wrapper for the stock OTLP metric exporter.
//
// Same gap as logs (see lib/retry-log-exporter.js): the stock OTLPMetricExporter reports a
// batch as failed on the first transport error and PeriodicExportingMetricReader then DROPS
// it - a keep-alive reset race, a brief server outage or an agent backpressure window silently
// loses every metric point generated in it. Spans (lib/span-exporter.js) and logs
// (lib/retry-log-exporter.js) already retry; metrics must not be the weak signal.
//
// This wrapper re-exports the SAME batch with exponential backoff (250 ms .. 5 s, jittered) for
// up to MONITORING_EXPORT_RETRY_SECONDS (default 30), mirroring the span/log paths. Non-retryable
// HTTP statuses (4xx other than 408/429) fail immediately. Retries stop once the exporter is
// shutting down so a process exit is never held up.
//
// Considered limit: unlike logs there is no disk spool here. Metric batches are aggregated
// deltas/cumulatives whose serialization for spooling is lossy; the retry window covers the
// observed transient classes (reset race, restart seconds). A longer outage still loses metrics.
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
