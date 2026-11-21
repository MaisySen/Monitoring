'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RetryingMetricExporter } = require('../lib/retry-metric-exporter');

const stub = (outcomes) => ({
  calls: 0,
  export(metrics, cb) {
    const o = outcomes[Math.min(this.calls++, outcomes.length - 1)];
    setTimeout(() => cb(o), 1);
  },
  selectAggregationTemporality() { return 1; },
  async shutdown() {},
});

test('a network failure is retried until the export succeeds', async () => {
  const netErr = () => ({ code: 1, error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const inner = stub([netErr(), netErr(), { code: 0 }]);
  const exp = new RetryingMetricExporter(inner, { retrySeconds: 10 });
  const res = await new Promise((r) => exp.export({ scopeMetrics: [] }, r));
  assert.equal(res.code, 0);
  assert.equal(inner.calls, 3);
});

test('retryable HTTP statuses are retried, other 4xx fail immediately', async () => {
  const status = (s) => ({ code: 1, error: Object.assign(new Error(`HTTP ${s}`), { code: s }) });
  const retried = stub([status(503), { code: 0 }]);
  const exp = new RetryingMetricExporter(retried, { retrySeconds: 10 });
  const ok = await new Promise((r) => exp.export({}, r));
  assert.equal(ok.code, 0);
  assert.equal(retried.calls, 2);

  const bad = stub([status(400), { code: 0 }]);
  const exp2 = new RetryingMetricExporter(bad, { retrySeconds: 10 });
  const failed = await new Promise((r) => exp2.export({}, r));
  assert.equal(failed.code, 1);
  assert.equal(bad.calls, 1);
});

test('the retry budget is honoured: a persistent failure reports FAILED after ~retrySeconds', async () => {
  const inner = stub([{ code: 1, error: Object.assign(new Error('down'), { code: 'ECONNREFUSED' }) }]);
  const exp = new RetryingMetricExporter(inner, { retrySeconds: 1 });
  const t = Date.now();
  const res = await new Promise((r) => exp.export({}, r));
  assert.equal(res.code, 1);
  assert.ok(Date.now() - t >= 900, 'kept retrying for about a second');
  assert.ok(inner.calls >= 2, 'made multiple attempts');
});

test('shutdown stops retries promptly', async () => {
  const inner = stub([{ code: 1, error: Object.assign(new Error('down'), { code: 'ECONNREFUSED' }) }]);
  const exp = new RetryingMetricExporter(inner, { retrySeconds: 30 });
  const p = new Promise((r) => exp.export({}, r));
  await new Promise((r) => setTimeout(r, 300));
  await exp.shutdown();
  const t = Date.now();
  const res = await p;
  assert.equal(res.code, 1);
  assert.ok(Date.now() - t < 2000, 'did not wait out the 30 s budget');
});

test('aggregation temporality selection delegates to the inner exporter', () => {
  const inner = stub([]);
  const exp = new RetryingMetricExporter(inner, { retrySeconds: 10 });
  assert.equal(exp.selectAggregationTemporality(3), 1);
});

test('forceFlush delegates to the inner exporter when it has one', async () => {
  let flushed = 0;
  const inner = { ...stub([]), async forceFlush() { flushed++; } };
  const exp = new RetryingMetricExporter(inner, { retrySeconds: 10 });
  await exp.forceFlush();
  assert.equal(flushed, 1);
});

test('an export after shutdown fails immediately without touching the inner exporter', async () => {
  const inner = stub([{ code: 0 }]);
  const exp = new RetryingMetricExporter(inner, { retrySeconds: 10 });
  await exp.shutdown();
  const res = await new Promise((r) => exp.export({}, r));
  assert.equal(res.code, 1);
  assert.equal(inner.calls, 0);
});
