'use strict';
// Wire-level tests for MetricBatchTracker + RetryingMetricExporter against a real HTTP server:
// every request's batch-id header and body bytes are captured, so these tests prove (not infer):
//  - the stock transport's internal retries reuse one id and byte-identical payloads;
//  - the headers callback really is invoked per HTTP send;
//  - wrapper retries (failures, timeouts, connection resets) keep the batch's id;
//  - a new batch always gets a fresh id, and ids never cross between overlapping exports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { MeterProvider, PeriodicExportingMetricReader, AggregationTemporality } = require('@opentelemetry/sdk-metrics');
const { RetryingMetricExporter, MetricBatchTracker } = require('../lib/retry-metric-exporter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real ResourceMetrics produced by the real SDK pipeline, so serialization is exercised exactly
// as in production. Distinct counter values make byte-distinct batches.
function makeBatch(value) {
  return new Promise((resolve, reject) => {
    const capture = {
      export(m, cb) { resolve(m); cb({ code: 0 }); },
      selectAggregationTemporality: () => AggregationTemporality.DELTA,
      async shutdown() {},
      async forceFlush() {},
    };
    const reader = new PeriodicExportingMetricReader({ exporter: capture, exportIntervalMillis: 3_600_000 });
    const mp = new MeterProvider({ readers: [reader] });
    mp.getMeter('wire').createCounter('wire.counter').add(value);
    mp.forceFlush().then(() => mp.shutdown()).catch(reject);
  });
}

// behavior(sendNumber, record, wire) -> {status, headers?} | 'hold' | 'destroy'
function startWire(behavior) {
  const wire = { sends: [], held: [], state: {}, port: 0 };
  wire.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const rec = {
        seq: wire.sends.length + 1,
        id: req.headers['x-monitoring-batch-id'] || null,
        bodyHash: crypto.createHash('sha256').update(body).digest('hex'),
      };
      wire.sends.push(rec);
      let action;
      try { action = behavior(rec.seq, rec, wire); } catch { action = { status: 500 }; }
      if (action === 'hold') { wire.held.push(res); return; }
      if (action === 'destroy') { req.socket.destroy(); return; }
      res.writeHead(action.status || 200, { 'content-type': 'application/x-protobuf', ...(action.headers || {}) });
      res.end(Buffer.alloc(0));
    });
  });
  wire.releaseAll = () => {
    for (const res of wire.held.splice(0)) {
      try { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(Buffer.alloc(0)); } catch { /* client may be gone */ }
    }
  };
  wire.waitForSends = async (n, ms = 5000) => {
    const t0 = Date.now();
    while (wire.sends.length < n && Date.now() - t0 < ms) await sleep(20);
    if (wire.sends.length < n) throw new Error(`timed out waiting for ${n} sends (got ${wire.sends.length})`);
  };
  wire.stop = () => new Promise((r) => {
    wire.releaseAll();
    wire.server.closeAllConnections?.();
    wire.server.close(() => r());
  });
  return new Promise((resolve) => {
    wire.server.listen(0, '127.0.0.1', () => { wire.port = wire.server.address().port; resolve(wire); });
  });
}

function mkExporter(wire, tracker, timeoutMillis) {
  return new OTLPMetricExporter({
    url: `http://127.0.0.1:${wire.port}/otlp/v1/metrics`,
    headers: tracker.headers,
    timeoutMillis,
    temporalityPreference: AggregationTemporality.DELTA,
  });
}

const runExport = (exp, metrics) => new Promise((r) => exp.export(metrics, r));

test('stock transport resends carry one id, byte-identical bodies, headers fn invoked per send', async () => {
  const wire = await startWire((n) => (n <= 2 ? { status: 500 } : { status: 200 }));
  try {
    const tracker = new MetricBatchTracker({});
    let headerCalls = 0;
    const spy = async () => { headerCalls++; return tracker.headers(); };
    const exporter = new OTLPMetricExporter({
      url: `http://127.0.0.1:${wire.port}/otlp/v1/metrics`,
      headers: spy,
      timeoutMillis: 6000, // budget for ~3 stock attempts (backoff 1s, 1.5s, ...)
      temporalityPreference: AggregationTemporality.DELTA,
    });
    const exp = new RetryingMetricExporter(exporter, { tracker, retrySeconds: 30 });
    const res = await runExport(exp, await makeBatch(11));
    assert.equal(res.code, 0);
    assert.ok(wire.sends.length >= 3, `expected the stock transport to resend, got ${wire.sends.length} sends`);
    const ids = new Set(wire.sends.map((s) => s.id));
    const hashes = new Set(wire.sends.map((s) => s.bodyHash));
    assert.equal(ids.size, 1, `one id across stock retries, saw ${[...ids]}`);
    assert.equal(hashes.size, 1, 'byte-identical payload across stock retries');
    assert.ok([...ids][0], 'batch id header present');
    assert.equal(headerCalls, wire.sends.length, 'headers callback invoked exactly once per HTTP send');
    await exp.shutdown();
  } finally {
    await wire.stop();
  }
});

test('connection resets then recovery: wrapper retries keep one id and one payload', async () => {
  const wire = await startWire((n) => (n <= 2 ? 'destroy' : { status: 200 }));
  try {
    const tracker = new MetricBatchTracker({});
    const exp = new RetryingMetricExporter(mkExporter(wire, tracker, 2000), { tracker, retrySeconds: 15 });
    const res = await runExport(exp, await makeBatch(21));
    assert.equal(res.code, 0);
    assert.ok(wire.sends.length >= 3, `expected wrapper-level resends after resets, got ${wire.sends.length}`);
    assert.equal(new Set(wire.sends.map((s) => s.id)).size, 1, 'one id across wrapper retries');
    assert.equal(new Set(wire.sends.map((s) => s.bodyHash)).size, 1, 'byte-identical payload across wrapper retries');
    await exp.shutdown();
  } finally {
    await wire.stop();
  }
});

test('a new batch gets a fresh id (changed bytes never reuse an id)', async () => {
  const wire = await startWire(() => ({ status: 200 }));
  try {
    const tracker = new MetricBatchTracker({});
    const exp = new RetryingMetricExporter(mkExporter(wire, tracker, 2000), { tracker, retrySeconds: 5 });
    assert.equal((await runExport(exp, await makeBatch(31))).code, 0);
    assert.equal((await runExport(exp, await makeBatch(32))).code, 0);
    assert.equal(wire.sends.length, 2);
    assert.ok(wire.sends[0].id && wire.sends[1].id, 'ids present on both batches');
    assert.notEqual(wire.sends[0].id, wire.sends[1].id, 'fresh id per batch');
    assert.notEqual(wire.sends[0].bodyHash, wire.sends[1].bodyHash, 'distinct payloads are byte-distinct');
    await exp.shutdown();
  } finally {
    await wire.stop();
  }
});

test('overlapping exports (reader-timeout orphan) never share or swap a batch id', async () => {
  // Reproduces the real overlap: the reader's callWithTimeout can fire while the wrapper keeps
  // retrying, then the next collection starts a second export. Without exporter-side
  // serialization a new beginBatch() would flip the shared id cell mid-retry, putting batch A's
  // payload on the wire under batch B's id - silently breaking server-side dedup.
  const wire = await startWire((_n, _r, w) => (w.state.holdAll ? 'hold' : { status: 200 }));
  try {
    wire.state.holdAll = true;
    const tracker = new MetricBatchTracker({});
    const exp = new RetryingMetricExporter(mkExporter(wire, tracker, 400), { tracker, retrySeconds: 20 });
    const mA = await makeBatch(41);
    const mB = await makeBatch(42);
    const pA = runExport(exp, mA);
    await wire.waitForSends(1);
    const idA = wire.sends[0].id;
    const hashA = wire.sends[0].bodyHash;
    const pB = runExport(exp, mB); // overlaps A while A is stuck in transport timeouts
    await sleep(1500); // A keeps timing out (400 ms) and wrapper-retrying; B must not touch the wire
    for (const s of wire.sends) {
      assert.equal(s.id, idA, `send ${s.seq} carried a foreign id while batch A was in flight`);
      assert.equal(s.bodyHash, hashA, `send ${s.seq} carried a foreign payload while batch A was in flight`);
    }
    wire.state.holdAll = false;
    wire.releaseAll();
    const [rA, rB] = await Promise.all([pA, pB]);
    assert.equal(rA.code, 0, 'batch A exported once the server recovered');
    assert.equal(rB.code, 0, 'batch B exported after A');
    const sendsA = wire.sends.filter((s) => s.bodyHash === hashA);
    const sendsB = wire.sends.filter((s) => s.bodyHash !== hashA);
    assert.ok(sendsA.length >= 2, 'batch A was retried');
    assert.ok(sendsB.length >= 1, 'batch B was sent');
    for (const s of sendsA) assert.equal(s.id, idA, 'batch A kept its id across every resend');
    const idsB = new Set(sendsB.map((s) => s.id));
    assert.equal(idsB.size, 1, 'batch B has exactly one id');
    assert.notEqual([...idsB][0], idA, 'batch B never wears batch A\'s id');
    await exp.shutdown();
  } finally {
    await wire.stop();
  }
});

test('pending queue is bounded: overflow fails fast, queued exports keep distinct ids', async () => {
  const wire = await startWire((_n, _r, w) => (w.state.holdAll ? 'hold' : { status: 200 }));
  try {
    wire.state.holdAll = true;
    const tracker = new MetricBatchTracker({});
    const exp = new RetryingMetricExporter(mkExporter(wire, tracker, 300), { tracker, retrySeconds: 20, maxQueue: 2 });
    const [m1, m2, m3, m4] = [await makeBatch(51), await makeBatch(52), await makeBatch(53), await makeBatch(54)];
    const p1 = runExport(exp, m1);
    await wire.waitForSends(1);
    const p2 = runExport(exp, m2);
    const p3 = runExport(exp, m3);
    const overflow = await runExport(exp, m4); // active(1) + pending(2) = at capacity
    assert.equal(overflow.code, 1);
    assert.match(String(overflow.error && overflow.error.message), /queue full/);
    wire.state.holdAll = false;
    wire.releaseAll();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.deepEqual([r1.code, r2.code, r3.code], [0, 0, 0]);
    const byHash = new Map();
    for (const s of wire.sends) {
      if (!byHash.has(s.bodyHash)) byHash.set(s.bodyHash, new Set());
      byHash.get(s.bodyHash).add(s.id);
    }
    assert.equal(byHash.size, 3, 'exactly the three admitted payloads reached the wire');
    for (const [hash, ids] of byHash) assert.equal(ids.size, 1, `payload ${hash.slice(0, 8)} used ${ids.size} ids`);
    assert.equal(new Set([...byHash.values()].map((ids) => [...ids][0])).size, 3, 'all three batch ids distinct');
    await exp.shutdown();
  } finally {
    await wire.stop();
  }
});

test('shutdown fails pending exports instead of holding them', async () => {
  const wire = await startWire(() => 'hold');
  try {
    const tracker = new MetricBatchTracker({});
    const exp = new RetryingMetricExporter(mkExporter(wire, tracker, 5000), { tracker, retrySeconds: 30 });
    const p1 = runExport(exp, await makeBatch(61));
    await wire.waitForSends(1);
    const p2 = runExport(exp, await makeBatch(62));
    await exp.shutdown();
    const t = Date.now();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(Date.now() - t < 3000, 'shutdown did not wait out the retry budget');
    assert.equal(r1.code, 1);
    assert.equal(r2.code, 1);
  } finally {
    await wire.stop();
  }
});
