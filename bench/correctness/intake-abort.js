// Request-level fault evidence: if a client connection dies mid-request, the partially
// received batch must store nothing (transactional intake => all-or-none per request).
// Sends a valid OTLP JSON traces payload but destroys the socket after half the body.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { execSync } = require('child_process');
const BASE = new URL(process.env.MONITORING_URL || 'http://127.0.0.1:4730');
const KEY = process.env.MONITORING_API_KEY || execSync('cat /tmp/reg-key').toString().trim();
const DB = process.env.DATABASE_URL || 'postgresql://monitoring@127.0.0.1:5433/e2e';
const traceId = crypto.randomBytes(16).toString('hex');
const span = (id) => ({ traceId, spanId: id, name: 'abort-probe', kind: 2, startTimeUnixNano: '1763000000000000000', endTimeUnixNano: '1763000001000000000' });
const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'abort-probe-svc' } }] }, scopeSpans: [{ scope: { name: 'probe' }, spans: [span('aa'.padStart(16, '0')), span('bb'.padStart(16, '0'))] }] }] });
const req = http.request({ hostname: BASE.hostname, port: BASE.port, path: '/otlp/v1/traces', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-monitoring-key': KEY } }, (res) => { console.log('unexpected full response', res.statusCode); process.exit(1); });
req.on('error', () => {});
req.write(body.slice(0, Math.floor(body.length / 2)));
setTimeout(() => { req.destroy(new Error('simulated client reset')); }, 50);
setTimeout(() => {
  const q = `set jit=off; select count(*) from spans where trace_id='${traceId}'`;
  const out = execSync(`psql "${DB}" -tAc "${q}"`, { env: { ...process.env, PATH: `/usr/lib/postgresql/14/bin:${process.env.PATH}` } }).toString().trim();
  console.log(JSON.stringify({ traceId, stored_after_client_abort: Number(out), pass: Number(out) === 0 }));
  process.exit(Number(out) === 0 ? 0 : 1);
}, 1500);
