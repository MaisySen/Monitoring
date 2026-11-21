'use strict';
// Retrying wrapper for the stock OTLP metric exporter. TEST-ONLY OPT-IN (MONITORING_METRICS_RETRY=true)
// until end-to-end safety review passes: see "Ambiguous delivery" below. Not the default: a wrong
// double-count is worse than a dropped batch.
//
// What the stock exporter already does (otlp-exporter-base 0.301.1, retrying-transport): every
// export retries RETRYABLE failures up to 5 times with 1s..5s backoff INSIDE the export timeout
// (timeoutMillis, default 10s), then reports the batch failed and PeriodicExportingMetricReader
// DROPS it. The stock retryable set is narrow (is-export-retryable.cjs): HTTP 429/502/503/504 and
// certain network errors only - a plain 500 (and every other status) fails immediately at the
// stock layer. This wrapper extends that horizon to MONITORING_EXPORT_RETRY_SECONDS (default 30s)
// for outages longer than one export timeout - agent backpressure, server restart seconds - and
// covers the statuses the stock layer refuses (500 included). Spans
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
// batch id on every request. beginBatch() is called by RetryingMetricExporter only when a batch
// becomes ACTIVE; the wrapper's internal serialization (below) guarantees no second batch can
// begin while a first is still being resent, so the mutable cell always names the batch actually
// on the wire. PeriodicExportingMetricReader alone does NOT provide that guarantee: its
// callWithTimeout can orphan an in-flight export (the reader moves on, the wrapper keeps
// retrying), and the next collection would flip this cell mid-retry.
//
// Age gate at the LAST hook before the wire: the stock transport's internal retry loop performs
// up to 5 sends per export call against its own deadline, and the wrapper's per-attempt check
// cannot see between those sends. This callback can: it throws once the active batch is older
// than maxAgeMs, failing the send BEFORE anything is transmitted, on every internal retry too.
// (The resulting transport error just fails the export; the wrapper then reports the batch
// expired.) A send already in flight when the cutoff passes still completes - the gate bounds
// send INITIATION, not completion.
class MetricBatchTracker {
  constructor(staticHeaders = {}) {
    this.staticHeaders = staticHeaders;
    this.current = null;
    this.currentBornAt = null;
    this.maxAgeMs = Infinity; // RetryingMetricExporter overwrites with its own maxAgeMs
    this.headers = async () => {
      if (this.currentBornAt != null && Date.now() - this.currentBornAt > this.maxAgeMs) {
        throw new Error(`metric batch expired (age ${Math.round((Date.now() - this.currentBornAt) / 1000)}s > max ${Math.round(this.maxAgeMs / 1000)}s); send aborted before transmission`);
      }
      return {
        ...this.staticHeaders,
        ...(this.current ? { 'x-monitoring-batch-id': this.current } : {}),
      };
    };
  }
  beginBatch(bornAt) {
    this.current = require('node:crypto').randomUUID();
    this.currentBornAt = bornAt ?? Date.now();
    return this.current;
  }
}

// Serialization: the batch id is only sound if exactly one batch is on the wire at a time.
// PeriodicExportingMetricReader can orphan an in-flight export when its callWithTimeout fires
// (exportTimeoutMillis, clamped to the export interval), while this wrapper keeps retrying to
// MONITORING_EXPORT_RETRY_SECONDS; the reader's next tick then starts a NEW export. Without a
// mutex here, that second export's beginBatch() flips the tracker's id cell while the first
// batch is still being resent - its payload goes out under the wrong id and server-side dedup
// silently misattributes or double-counts. So export() queues: one active batch at a time, a new
// id taken only when a batch becomes active, pending batches bounded by maxQueue
// (MONITORING_EXPORT_RETRY_QUEUE, default 10). Overflow fails fast (the reader drops that batch,
// same as any failed export) rather than growing memory through a long outage; shutdown fails
// every pending batch immediately so process exit is never held up.
//
// Maximum age (enforced, not sampled): server-side dedup only lasts until the claim row is swept
// (MONITORING_BATCH_RETENTION_HOURS, default 48). A retry arriving after that double-counts, so a
// batch must never be sent once it is too old - and a measured "typical" age is no bound at all:
// host suspension, event-loop stalls, operator-set retry budgets/queue sizes, and slow in-flight
// sends all sit outside any sample. Every batch is therefore stamped (bornAt) at enqueue and the
// wrapper refuses to START any send once age > maxAgeMs (MONITORING_EXPORT_MAX_AGE_SECONDS,
// default 600). The check runs at activation, before every wrapper attempt, and - via the
// tracker's headers callback throwing - before EVERY stock-transport internal send, so the
// built-in retry loop cannot transmit past the cutoff either (its own wall-clock deadline stops
// it after a suspend, but without the callback gate it would keep sending up to timeoutMillis
// past the cutoff in normal operation). Keep
// max age comfortably below the server retention (defaults: 10 min vs 48 h); the client cannot
// verify the server's retention setting, so that invariant remains operator responsibility.
// Residual: a send already in flight when the host suspends can still complete after the cutoff
// (its start was inside it); the cutoff gates send initiation, not completion.
class RetryingMetricExporter {
  constructor(inner, opts = {}) {
    this.inner = inner;
    this.retryMs = Number(opts.retrySeconds ?? process.env.MONITORING_EXPORT_RETRY_SECONDS ?? 30) * 1000;
    this.maxAgeMs = Number(opts.maxAgeSeconds ?? process.env.MONITORING_EXPORT_MAX_AGE_SECONDS ?? 600) * 1000;
    this.stopped = false;
    this.tracker = opts.tracker || null;
    this.maxQueue = Number(opts.maxQueue ?? process.env.MONITORING_EXPORT_RETRY_QUEUE ?? 10);
    this.pending = [];
    this.active = false;
    if (this.tracker) this.tracker.maxAgeMs = this.maxAgeMs; // per-send gate inside stock internal retries
  }
  export(metrics, resultCallback) {
    if (this.stopped) return resultCallback({ code: 1, error: new Error('exporter shut down') });
    if (this.pending.length >= this.maxQueue) {
      return resultCallback({ code: 1, error: new Error(`metric retry queue full (${this.maxQueue}); dropping batch`) });
    }
    this.pending.push({ metrics, resultCallback, bornAt: Date.now() });
    setImmediate(() => this._drain());
  }
  _expired(item) {
    const age = Date.now() - item.bornAt;
    return age > this.maxAgeMs ? new Error(`metric batch expired (age ${Math.round(age / 1000)}s > max ${Math.round(this.maxAgeMs / 1000)}s); dropping`) : null;
  }
  _drain() {
    if (this.active) return;
    const item = this.pending.shift();
    if (!item) return;
    this.active = true;
    const expired = this._expired(item);
    if (expired) return this._finish(item, { code: 1, error: expired });
    if (this.tracker) this.tracker.beginBatch(item.bornAt);
    const deadline = Date.now() + this.retryMs;
    const attempt = (n) => {
      const tooOld = this._expired(item);
      if (tooOld) return this._finish(item, { code: 1, error: tooOld });
      this.inner.export(item.metrics, (res) => {
        if (res.code === SUCCESS) return this._finish(item, res);
        const status = statusOf(res.error);
        const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        const remaining = deadline - Date.now();
        if (!retryable || this.stopped || remaining <= 0) return this._finish(item, res);
        const delay = Math.min(Math.min(5000, 250 * 2 ** n) * (0.8 + Math.random() * 0.4), remaining);
        setTimeout(() => attempt(n + 1), delay);
      });
    };
    attempt(0);
  }
  _finish(item, res) {
    this.active = false;
    item.resultCallback(res);
    setImmediate(() => this._drain());
  }
  selectAggregationTemporality(instrumentType) {
    return this.inner.selectAggregationTemporality
      ? this.inner.selectAggregationTemporality(instrumentType)
      : 0; // AggregationTemporality.CUMULATIVE fallback; the wired reader passes DELTA via the inner exporter
  }
  async shutdown() {
    this.stopped = true;
    const err = { code: 1, error: new Error('exporter shut down') };
    for (const item of this.pending.splice(0)) item.resultCallback(err);
    return this.inner.shutdown();
  }
  async forceFlush() {
    return this.inner.forceFlush ? this.inner.forceFlush() : undefined;
  }
}

module.exports = { RetryingMetricExporter, MetricBatchTracker };
