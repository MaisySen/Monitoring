#!/usr/bin/env node
// Regression: every ingested root span must be counted EXACTLY ONCE in the span_stats rollups.
//
//   MONITORING_URL=http://127.0.0.1:4620 MONITORING_SETUP_TOKEN=... DATABASE_URL=postgresql://... node bench/correctness/span-stats-once.js
//
// The server must run against a FRESH database (first boot creates span_stats and used to
// backfill spans that intake had already recorded into its in-memory aggregates, counting
// them twice - measured 2026-11-21 as exactly 2x root spans on the service catalog).
// Set MONITORING_STATS_FLUSH_MS low on the server (e.g. 2000) so the flush lands quickly.
//
// Asserts, per service: span_stats sum(hits) == raw root spans == traces sent,
// span_stats sum(errors) == raw error roots == errors sent. Any doubling fails the bench.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:4620';
const SETUP = process.env.MONITORING_SETUP_TOKEN;
const RUN = crypto.randomBytes(3).toString('hex');
const psql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, expected, actual, pass) => { results.push({ name, expected, actual, pass: !!pass }); process.stderr.write(`${pass ? 'ok  ' : 'FAIL'} ${name}: expected ${expected}, got ${actual}\n`); };

function req(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(DC + path);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data); r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const ns = (ms) => String(BigInt(ms) * 1000000n);

(async () => {
  const health = await req('GET', '/api/healthz');
  if (health.status !== 200) throw new Error(`server not healthy: ${health.status}`);
  const admin = { email: `stats-${RUN}@monitoring.local`, password: `Stats-${crypto.randomBytes(9).toString('hex')}`, name: 'Stats' };
  let r = await req('POST', '/api/auth/setup', { ...admin, orgName: `Stats ${RUN}`, setupToken: SETUP });
  if (r.status !== 200) throw new Error(`setup: ${r.status} ${r.body.slice(0, 200)}`);
  const login = await req('POST', '/api/auth/login', { email: admin.email, password: admin.password });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => c.includes('=') && c.split(/=(.*)/s)[1]).join('; ');
  r = await req('POST', '/api/ui/org/keys', { name: 'stats', kind: 'api' }, { cookie });
  const key = json(r)?.key;
  if (!key) throw new Error('no api key');

  // two services with exact known counts: svc1 40 traces + 20 children + 5 errors; svc2 25 traces + 0 children + 3 errors
  const PLAN = [
    { service: `stats-a-${RUN}`, traces: 40, children: 20, errors: 5 },
    { service: `stats-b-${RUN}`, traces: 25, children: 0, errors: 3 },
  ];
  const now = Date.now();
  for (const p of PLAN) {
    const resourceSpans = [];
    for (let i = 0; i < p.traces; i++) {
      const traceId = crypto.randomBytes(16).toString('hex');
      const rootId = crypto.randomBytes(8).toString('hex');
      const t = now - 120000 + i * 1000; // inside the current hour, finished minutes
      const spans = [{ traceId, spanId: rootId, name: `op-${i % 4}`, kind: 2, startTimeUnixNano: ns(t), endTimeUnixNano: ns(t + 50), ...(i < p.errors ? { status: { code: 2 } } : {}) }];
      if (i < p.children) spans.push({ traceId, spanId: crypto.randomBytes(8).toString('hex'), parentSpanId: rootId, name: 'child', kind: 3, startTimeUnixNano: ns(t), endTimeUnixNano: ns(t + 20) });
      resourceSpans.push({ resource: { attributes: [{ key: 'service.name', value: { stringValue: p.service } }] }, scopeSpans: [{ scope: { name: 'stats' }, spans }] });
    }
    r = await req('POST', '/otlp/v1/traces', { resourceSpans }, { 'dd-api-key': key });
    if (r.status >= 300) throw new Error(`intake ${p.service}: ${r.status} ${r.body.slice(0, 160)}`);
  }

  // wait for at least two flush cycles (flush interval is server-side; default 10s)
  await sleep(Number(process.env.STATS_WAIT_MS ?? 15000));

  let failed = 0;
  for (const p of PLAN) {
    const raw = psql(`select count(*), count(*) filter (where parent_id='0'), count(*) filter (where parent_id='0' and error=1) from spans where service='${p.service}'`);
    const [total, roots, errRoots] = raw.split('\n')[0].split('|').map(Number);
    const stats = psql(`select coalesce(sum(hits),0), coalesce(sum(errors),0) from span_stats where service='${p.service}'`);
    const [hits, statErrs] = stats.split('\n')[0].split('|').map(Number);
    check(`${p.service} raw rows`, `traces+children=${p.traces + p.children}`, total, total === p.traces + p.children);
    check(`${p.service} raw roots`, p.traces, roots, roots === p.traces);
    check(`${p.service} rollup hits == roots (counted once)`, p.traces, hits, hits === p.traces);
    check(`${p.service} rollup errors == raw error roots`, p.errors, `${statErrs} (raw ${errRoots})`, statErrs === p.errors && errRoots === p.errors);
    if (hits !== p.traces || statErrs !== p.errors) failed++;
  }

  // second cycle: after another flush the sums must not move (no re-count, no compaction drift)
  await sleep(Number(process.env.STATS_WAIT_MS ?? 15000));
  for (const p of PLAN) {
    const [hits] = psql(`select coalesce(sum(hits),0) from span_stats where service='${p.service}'`).split('\n')[0].split('|').map(Number);
    check(`${p.service} rollup stable after another flush`, p.traces, hits, hits === p.traces);
    if (hits !== p.traces) failed++;
  }

  console.log(JSON.stringify({ suite: 'span-stats-once', total: results.length, failed: results.filter((x) => !x.pass).length, results }, null, 1));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
