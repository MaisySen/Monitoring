// Checks correlate.ts's version-change rules with synthetic, backdated spans (OTLP JSON straight to intake).
// Each scenario uses its own fresh service so they cannot interfere. Window = last 2 min, baseline = the 2 min before.
//   restart   v1 runs, goes quiet for 8 min, v1 comes back in the window          -> no version change reported
//   new       v1 runs up to the window, v2 appears in the window                  -> "version v2 first seen"
//   rollback  v1 runs, v2 runs, then v1 again up to the window, v2 in the window   -> "version v2 returned"
//   canary    v1 and v2 both run up to the window, both continue                  -> no version change reported
// usage: node correlation-rules.js > correlation-rules.json   (needs MONITORING_EMAIL/MONITORING_PASSWORD and MONITORING_API_KEY)
const fs = require('fs');
const crypto = require('crypto');
const env = require('../lib/env');
const BASE = env.url();
const KEY = env.apiKey();
const pass = env.password();
const now = Date.now();
const run = crypto.randomBytes(3).toString('hex');
const min = 60_000;

function spans(service, version, fromMs, toMs, everyMs = 5000) {
  const out = [];
  for (let t = fromMs; t < toMs; t += everyMs) out.push({ traceId: crypto.randomBytes(16).toString('hex'), spanId: crypto.randomBytes(8).toString('hex'), name: 'GET /x', kind: 2,
    startTimeUnixNano: String(BigInt(t) * 1000000n), endTimeUnixNano: String(BigInt(t + 20) * 1000000n), status: { code: 1 },
    attributes: [{ key: 'http.route', value: { stringValue: '/x' } }, { key: 'http.request.method', value: { stringValue: 'GET' } }] });
  return { resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'service.version', value: { stringValue: version } }, { key: 'deployment.environment.name', value: { stringValue: 'corrtest' } }] }, scopeSpans: [{ scope: { name: 'corrtest' }, spans: out }] };
}
async function send(resourceSpans) {
  const r = await fetch(`${BASE}/otlp/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', 'DC-API-KEY': KEY }, body: JSON.stringify({ resourceSpans }) });
  if (!r.ok) throw new Error(`intake ${r.status} ${await r.text()}`);
}
async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: env.email(), password: pass }) });
  const sids = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => c.startsWith('sid=') && c.length > 4);
  return sids[sids.length - 1];
}

const W = now - 2 * min; // window start; baseline starts at now - 4 min
const scenarios = {
  restart: { rs: (s) => [spans(s, '1.0.0', now - 30 * min, now - 12 * min), spans(s, '1.0.0', W + 10_000, now - 5000)], expect: [] },
  new: { rs: (s) => [spans(s, '1.0.0', now - 30 * min, W + 20_000), spans(s, '2.0.0', W + 30_000, now - 5000)], expect: ['version 2.0.0 first seen'] },
  rollback: { rs: (s) => [spans(s, '1.0.0', now - 60 * min, now - 50 * min), spans(s, '2.0.0', now - 50 * min, now - 40 * min), spans(s, '1.0.0', now - 40 * min, W + 20_000), spans(s, '2.0.0', W + 30_000, now - 5000)], expect: ['version 2.0.0 returned'] },
  canary: { rs: (s) => [spans(s, '1.0.0', now - 30 * min, now - 5000), spans(s, '2.0.0', now - 30 * min, now - 5000, 20_000)], expect: [] },
};

(async () => {
  for (const [name, sc] of Object.entries(scenarios)) await send(sc.rs(`corrtest-${name}-${run}`));
  await new Promise((r) => setTimeout(r, 8000)); // let intake flush
  const sid = await login();
  const results = [];
  for (const [name, sc] of Object.entries(scenarios)) {
    const svc = `corrtest-${name}-${run}`;
    const r = await fetch(`${BASE}/api/ui/correlate/${svc}?from=${Math.floor(W / 1000)}&to=${Math.floor(now / 1000)}`, { headers: { cookie: sid } });
    const d = await r.json();
    const got = (d.changes || []).filter((c) => c.kind === 'version').map((c) => c.detail);
    const pass = JSON.stringify(got) === JSON.stringify(sc.expect);
    results.push({ scenario: name, service: svc, expected: sc.expect, got, pass, evidence: (d.changes || []).filter((c) => c.kind === 'version').map((c) => c.evidence) });
    console.error(`${pass ? 'PASS' : 'FAIL'} ${name}: expected ${JSON.stringify(sc.expect)} got ${JSON.stringify(got)}`);
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), passed: results.filter((r) => r.pass).length, total: results.length, results }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
