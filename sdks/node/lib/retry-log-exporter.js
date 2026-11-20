'use strict';
// Retrying wrapper for the stock OTLP log exporter.
//
// The stock OTLPLogExporter reports a batch as failed on the first transport error and the
// BatchLogRecordProcessor then DISCARDS it. During a server outage the agent can backpressure or
// refuse log intake for tens of seconds while it queues to disk, and every log record generated in
// that window is silently lost (measured in bench/resilience: 3,888 of 9,000 logs lost during a
// 60 s server outage while the retrying span path lost only the kill-second window). Spans survive
// because lib/span-exporter.js retries; logs must not be the weak signal.
//
// This wrapper re-exports the SAME batch with exponential backoff (250 ms .. 5 s, jittered) for up
// to MONITORING_EXPORT_RETRY_SECONDS (default 30), mirroring the span path. Non-retryable HTTP
// statuses (4xx other than 408/429) fail immediately. Retries stop once the exporter is shutting
// down so a process exit is never held up.
const SUCCESS = 0;
const FAILED = 1;

function statusOf(error) {
  if (!error) return 0;
  const c = error.code ?? error.statusCode;
  // Network errors carry string codes (ECONNRESET, ETIMEDOUT, ...): no numeric status, retryable.
  return typeof c === 'number' ? c : 0;
}

class RetryingLogExporter {
  constructor(inner, opts = {}) {
    this.inner = inner;
    this.retryMs = Number(opts.retrySeconds ?? process.env.MONITORING_EXPORT_RETRY_SECONDS ?? 30) * 1000;
    this.stopped = false;
  }
  export(records, resultCallback) {
    if (this.stopped) return resultCallback({ code: FAILED, error: new Error('exporter shut down') });
    const deadline = Date.now() + this.retryMs;
    const attempt = (n) => {
      this.inner.export(records, (res) => {
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
  async shutdown() {
    this.stopped = true;
    return this.inner.shutdown();
  }
  async forceFlush() {
    return this.inner.forceFlush ? this.inner.forceFlush() : undefined;
  }
}

module.exports = { RetryingLogExporter };
