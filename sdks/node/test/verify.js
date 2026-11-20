'use strict';
// Isolated local sink verification, or agentless example smoke test.
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const remote = process.env.MONITORING_VERIFY_REMOTE === 'true';
const captured = { traces: [], metrics: [], logs: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Minimal protobuf wire reader for the OTLP fields asserted below. No generated
// schema dependency is needed by this verification-only script.
function fields(buffer) {
  let pos = 0;
  const out = new Map();
  function integer() {
    let result = 0n, shift = 0n;
    while (pos < buffer.length) {
      const byte = buffer[pos++];
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('Invalid protobuf varint');
    }
    throw new Error('Truncated protobuf');
  }
  while (pos < buffer.length) {
    const tag = Number(integer());
    const wire = tag & 7;
    let value;
    if (wire === 0) value = integer();
    else if (wire === 2) { const n = Number(integer()); value = buffer.subarray(pos, pos + n); pos += n; }
    else if (wire === 1 || wire === 5) { const n = wire === 1 ? 8 : 4; value = buffer.subarray(pos, pos + n); pos += n; }
    else throw new Error(`Unexpected protobuf wire type ${wire}`);
    const values = out.get(tag >>> 3) || [];
    values.push(value);
    out.set(tag >>> 3, values);
  }
  return out;
}
function records(requests) {
  return requests.flatMap(body => (fields(body).get(1) || []).flatMap(resource =>
    (fields(resource).get(2) || []).flatMap(scope => fields(scope).get(2) || []))).map(fields);
}
async function main() {
  let sink, child;
  let childOutput = '';
  try {
    const env = { ...process.env, MONITORING_SERVICE: 'monitoring-node-verify', MONITORING_ENV: 'verification', PORT: '18081' };
    if (!remote) {
      sink = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const signal = req.url.split('/').at(-1);
          try {
            assert.equal(req.headers['content-type'], 'application/x-protobuf');
            assert.equal(req.headers['dc-api-key'], 'local-verification-only');
            let body = Buffer.concat(chunks);
            if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
            assert(captured[signal], `Unexpected OTLP signal ${signal}`);
            captured[signal].push(body);
            res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
          } catch (error) { res.writeHead(400).end(error.message); }
        });
      });
      await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
      env.MONITORING_URL = `http://127.0.0.1:${sink.address().port}`;
      env.MONITORING_API_KEY = 'local-verification-only';
    } else {
      assert(env.MONITORING_URL && env.MONITORING_API_KEY, 'Remote verification requires MONITORING_URL and MONITORING_API_KEY');
    }
    child = spawn(process.execPath, ['-r', './init', 'examples/app.js'], {
      cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { childOutput += data; });
    child.stderr.on('data', data => { childOutput += data; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Example exited early: ${childOutput}`);
      try {
        const response = await fetch('http://127.0.0.1:18081/work', { signal: AbortSignal.timeout(1000) });
        if (response.ok) { await response.text(); ready = true; break; }
      } catch {}
      await sleep(100);
    }
    assert(ready, `Example did not become ready: ${childOutput}`);
    child.kill('SIGTERM');
    const result = await Promise.race([exited, sleep(30000).then(() => { throw new Error('Example shutdown timed out'); })]);
    assert.equal(result.code, 0, childOutput);
    assert.match(childOutput, /"trace_id":"[0-9a-f]{32}"/);
    assert.match(childOutput, /"span_id":"[0-9a-f]{16}"/);
    if (!remote) {
      const spans = records(captured.traces);
      const logs = records(captured.logs);
      const metrics = records(captured.metrics);
      const custom = spans.find(span => span.get(5)?.[0].toString() === 'example.work');
      assert(custom, 'Missing custom span');
      assert(spans.some(span => span.get(6)?.[0] === 2n), 'Missing HTTP server span');
      const correlated = logs.find(log => log.get(9)?.[0].equals(custom.get(1)[0]) &&
        log.get(10)?.[0].equals(custom.get(2)[0]));
      assert(correlated, 'Missing trace-correlated OTLP log');
      const counter = metrics.find(metric => metric.get(1)?.[0].toString() === 'monitoring.example.node.requests');
      assert(counter, 'Missing custom counter');
      assert.equal(fields(counter.get(7)[0]).get(2)[0], 1n, 'Counter is not DELTA');
      const histogram = metrics.find(metric => metric.get(1)?.[0].toString() === 'monitoring.example.node.duration');
      assert(histogram, 'Missing custom histogram');
      assert.equal(fields(histogram.get(9)[0]).get(2)[0], 1n, 'Histogram is not DELTA');
      console.log(JSON.stringify({ verified: 'node', spans: spans.length, correlatedLogs: logs.length, metrics: metrics.length, temporality: 'DELTA' }));
    } else {
      console.log('Monitoring Node example completed; query service=monitoring-node-verify and metric=monitoring.example.node.requests.');
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (sink) await new Promise(resolve => sink.close(resolve));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
