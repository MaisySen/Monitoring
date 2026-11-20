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
const { Spool, startDrainPump } = require('./spool');

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
    // Optional disk spool for outages longer than the retry window (see lib/spool.js).
    this.spool = process.env.MONITORING_EXPORT_SPOOL_DIR
      ? new Spool(process.env.MONITORING_EXPORT_SPOOL_DIR, { prefix: 'logs' })
      : null;
    if (this.spool) {
      this.startDrain = startDrainPump(this.spool, async () => {
        await this.spool.drain((records) => new Promise((resolve) => {
          if (process.env.DIAG_LOGS) {
            const seqs = records.map(r => r.attributes?.seq).filter(x => x !== undefined);
            console.error(`[diaglogs] drain-send n=${records.length} seqs=${Math.min(...seqs)}..${Math.max(...seqs)}`);
          }
          let slim;
          try {
            slim = records.map(slimRecord);
          } catch {
            return resolve(false);
          }
          this.inner.export(slim, (res) => resolve(res.code === SUCCESS));
        }));
        return this.spool.files().length === 0;
      });
      this.startDrain(); // a previous process may have left batches behind
    }
  }
  export(records, resultCallback) {
    if (process.env.DIAG_LOGS) {
      const seqs = records.map(r => r.attributes?.seq).filter(x => x !== undefined);
      console.error(`[diaglogs] export n=${records.length} seqs=${Math.min(...seqs)}..${Math.max(...seqs)} stopped=${this.stopped}`);
    }
    // A batch flushed after shutdown began still goes to the spool rather than vanishing.
    if (this.stopped) {
      if (this.spool) { this.spool.write(records); this.startDrain(); }
      return resultCallback({ code: FAILED, error: new Error('exporter shut down') });
    }
    const deadline = Date.now() + this.retryMs;
    const attempt = (n) => {
      this.inner.export(records, (res) => {
        if (res.code === SUCCESS) return resultCallback(res);
        const status = statusOf(res.error);
        const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        const remaining = deadline - Date.now();
        if (!retryable || this.stopped || remaining <= 0) {
          if (process.env.DIAG_LOGS) console.error(`[diaglogs] giveup retryable=${retryable} stopped=${this.stopped} remaining=${remaining} status=${status} n=${records.length}`);
          if (retryable && this.spool) {
            this.spool.write(records);
            this.startDrain();
          }
          return resultCallback(res);
        }
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

// A LogRecord keeps its data in underscore-prefixed fields behind getters; a JSON round-trip
// loses the getters, so a spooled record must be rebuilt as a plain object with the field names
// the OTLP serializer reads. Handles both live records and already-serialized spool entries.
function slimRecord(r) {
  const get = (k) => (r[k] !== undefined ? r[k] : r['_' + k]);
  return {
    hrTime: get('hrTime'),
    hrTimeObserved: get('hrTimeObserved'),
    spanContext: get('spanContext'),
    severityText: get('severityText'),
    severityNumber: get('severityNumber'),
    body: get('body'),
    attributes: get('attributes'),
    droppedAttributesCount: get('droppedAttributesCount'),
    resource: { attributes: (get('resource') && get('resource').attributes) || {} },
    instrumentationScope: get('instrumentationScope'),
  };
}

module.exports = { RetryingLogExporter };
