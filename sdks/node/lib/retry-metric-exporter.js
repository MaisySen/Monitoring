'use strict';
// Retrying wrapper for the stock OTLP metric exporter. OPT-IN ONLY (MONITORING_METRICS_RETRY=true)
// until end-to-end safety review passes: see "Ambiguous delivery" below. Not the default: a wrong
// double-count is worse than a dropped batch.
//
// What the stock exporter already does (otlp-exporter-base 0.301.1, retrying-transport): every
// export retries retryable failures up to 5 times with 1s..5s backoff INSIDE the export timeout
// (timeoutMillis, default 10s), then reports the batch failed and PeriodicExportingMetricReader
// DROPS it. This wrapper extends that horizon to MONITORING_EXPORT_RETRY_SECONDS (default 30s)
// for outages longer than one export timeout - agent backpressure, server restart seconds. Spans
// (lib/span-exporter.js) and logs (lib/retry-log-exporter.js) already retry on that horizon.
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
// why this wrapper is opt-in and why the server now offers intake batch idempotency
// (migration 20): send x-monitoring-batch-id and retries of one batch dedup server-side.
// BatchTracker below gives every export batch a stable id across EVERY resend (the stock
// transport calls the headers function per HTTP send, verified in
// otlp-exporter-base/dist/platform/node/transport/http-exporter-transport.js) - so retries are
// safe against servers that implement the header, and unchanged against backends that ignore
// it (ClickHouse intake, older servers: no dedup, same as before this header existed).
// A server-side idempotent insert for paths without the header remains a separate question.
const SUCCESS = 0;

function statusOf(error) {
  if (!error) return 0;
  const c = error.code ?? error.statusCode;
  // Network errors carry string codes (ECONNRESET, ETIMEDOUT, ...): no numeric status, retryable.
  return typeof c === 'number' ? c : 0;
}

// One id per export BATCH, stable across every resend of that batch (stock-transport retries and
// wrapper retries), fresh for the next batch. The stock HTTP transport invokes the headers
// function per send, so passing tracker.headers to the exporter constructor puts the current
// batch id on every request. PeriodicExportingMetricReader serializes exports, so a single
// mutable cell is safe; beginBatch() runs before any send of that batch can start.
class MetricBatchTracker {
  constructor(staticHeaders = {}) {
    this.staticHeaders = staticHeaders;
    this.current = null;
    this.headers = async () => ({
      ...this.staticHeaders,
      ...(this.current ? { 'x-monitoring-batch-id': this.current } : {}),
    });
  }
  beginBatch() {
    this.current = require('node:crypto').randomUUID();
    return this.current;
  }
}

class RetryingMetricExporter {
  constructor(inner, opts = {}) {
    this.inner = inner;
    this.retryMs = Number(opts.retrySeconds ?? process.env.MONITORING_EXPORT_RETRY_SECONDS ?? 30) * 1000;
    this.stopped = false;
    this.tracker = opts.tracker || null;
  }
  export(metrics, resultCallback) {
    if (this.stopped) return resultCallback({ code: 1, error: new Error('exporter shut down') });
    if (this.tracker) this.tracker.beginBatch();
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

module.exports = { RetryingMetricExporter, MetricBatchTracker };
