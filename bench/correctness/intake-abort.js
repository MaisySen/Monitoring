// Request-level fault evidence: if a client connection dies mid-request, the partially
// received batch must store nothing (transactional intake => all-or-none per request).
//
// Positive control first: a complete request from the same client MUST be stored, proving
// auth/path/DB visibility work. Without it, a zero count proves nothing (a 403 from a wrong
// header or a query that cannot match also yields zero). Rows are matched by a per-run
// unique service name; trace_id is stored in decimal form, not hex.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { execSync } = require('child_process');
const BASE = new URL(process.env.MONITORING_URL || process.env.SERVER_URL || 'http://127.0.0.1:4730');
const KEY = process.env.MONITORING_API_KEY || process.env.API_KEY;
const DB = process.env.PGDATABASE || 'e2e';
if (!KEY) { console.error('set API_KEY (or MONITORING_API_KEY)'); process.exit(2); }
// psql connection via PG* env (defaults match the other regression checks; CI overrides them).
const pgEnv = { ...process.env,
  PGHOST: process.env.PGHOST || '127.0.0.1',
  PGPORT: process.env.PGPORT || '5433',
  PGUSER: process.env.PGUSER || 'monitoring',
  PATH: `${process.env.HOME}/pgsql/usr/lib/postgresql/14/bin:/usr/lib/postgresql/14/bin:${process.env.PATH}` };
const stored = (svc) => Number(execSync(`psql -d "${DB}" -tAc "select count(*) from spans where service='${svc}'"`, { env: pgEnv }).toString().trim());
const RUN = crypto.randomBytes(4).toString('hex');
const payload = (svc) => JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: svc } }] }, scopeSpans: [{ scope: { name: 'probe' }, spans: [0, 1].map((i) => ({
  traceId: crypto.randomBytes(16).toString('hex'), spanId: crypto.randomBytes(8).toString('hex'), name: 'abort-probe', kind: 2,
  startTimeUnixNano: String(BigInt(Date.now()) * 1000000n), endTimeUnixNano: String(BigInt(Date.now()) * 1000000n + 1000000n) })) }] }] });
const reqOpts = { hostname: BASE.hostname, port: BASE.port, path: '/otlp/v1/traces', method: 'POST' };
const headers = (body) => ({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'dc-api-key': KEY });

// 1. Positive control: complete request must store both spans.
const ctlSvc = `abort-ctl-${RUN}`;
const ctlBody = payload(ctlSvc);
const ctl = http.request({ ...reqOpts, headers: headers(ctlBody) }, (res) => {
  if (res.statusCode !== 200) { console.log(JSON.stringify({ pass: false, stage: 'control', status: res.statusCode, note: 'control request not accepted; check API key/header' })); process.exit(1); }
  res.resume();
  res.on('end', () => {
    setTimeout(() => {
      const n = stored(ctlSvc);
      if (n !== 2) { console.log(JSON.stringify({ pass: false, stage: 'control', stored: n, expected: 2 })); process.exit(1); }
      // 2. Fault: destroy the socket mid-body.
      const abtSvc = `abort-fault-${RUN}`;
      const abtBody = payload(abtSvc);
      const req = http.request({ ...reqOpts, headers: headers(abtBody) }, (res) => { console.log(JSON.stringify({ pass: false, stage: 'abort', note: 'unexpected full response', status: res.statusCode })); process.exit(1); });
      req.on('error', () => {});
      req.write(abtBody.slice(0, Math.floor(abtBody.length / 2)));
      setTimeout(() => { req.destroy(new Error('simulated client reset')); }, 50);
      setTimeout(() => {
        const m = stored(abtSvc);
        console.log(JSON.stringify({ pass: m === 0, control_stored: n, stored_after_client_abort: m }));
        process.exit(m === 0 ? 0 : 1);
      }, 3000);
    }, 3000);
  });
});
ctl.write(ctlBody);
ctl.end();
