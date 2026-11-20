#!/usr/bin/env node
// Telemetry correctness harness: sends a workload whose results are known in advance through Monitoring's libraries and
// agent, then checks what Monitoring reports (API + UI queries) against that ground truth.
//
//   MONITORING_URL=http://localhost:3000 MONITORING_EMAIL=... MONITORING_PASSWORD=... node run.js > report.json
//
// Ground truth comes from the plan (how many requests of each kind, which ones fail) and from the client's own
// measurements (latency of every request, trace ID returned by the server). Checks:
//   hits         per resource and per service: exact
//   errors       count and error rate: exact
//   latency      p50/p95/p99 per resource and per service vs the client-measured percentiles of the same requests:
//                within 2% (histogram resolution) + 2 ms (client-side network/queueing that the server span excludes),
//                and never below the injected sleep
//   logs         count per service and per status: exact; every gateway log carries a trace ID that exists in spans
//   traces       for sampled chain requests: both services present, every parent ID resolves, both logs attached
//   metrics      custom counter truth.requests by kind: exact sums
'use strict';
const env = require('../lib/env');
const http = require('http');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const path = require('path');

const DC = env.url();
const EMAIL = env.email();
const PASSWORD = env.password();
const N = Number(process.env.N || 3000);
const CONC = Number(process.env.CONC || 8);
const RUN = process.env.RUN || Math.random().toString(36).slice(2, 8);
const FB = env.deps();
const GW = `truth-gw-${RUN}`, PY = `truth-py-${RUN}`;
const MIX = [['fast', 55], ['medium', 22], ['slow', 8], ['fail', 5], ['chain', 10]];
const SLEEP_MS = { fast: 10, medium: 50, slow: 200, fail: 20, chain: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- plan: deterministic interleaving of kinds with exact proportions ----------
const plan = [];
for (const [kind, pct] of MIX) for (let i = 0; i < N * pct / 100; i++) plan.push(kind);
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const pctile = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

async function main() {
  fs.mkdirSync('/var/log/truth', { recursive: true });
  // ---------- start the two services on the Monitoring stack (libraries -> Monitoring Agent on :4318) ----------
  const env = { ...process.env, MONITORING_ENV: 'truth', MONITORING_VERSION: RUN };
  delete env.MONITORING_URL; delete env.MONITORING_API_KEY; delete env.DD_AGENT_HOST; delete env.DD_AGENT_PORT;
  const procs = [
    spawn('node', ['-r', `${FB}/node/node_modules/@monitoring/trace/init`, path.join(__dirname, 'truth-gateway.js')],
      { env: { ...env, NODE_PATH: `${FB}/node/node_modules`, MONITORING_SERVICE: GW }, stdio: 'ignore', detached: true }),
    spawn(`${FB}/venv/bin/monitoring-run`, [`${FB}/venv/bin/python`, path.join(__dirname, 'truth-lookup.py')],
      { env: { ...env, MONITORING_SERVICE: PY }, stdio: 'ignore', detached: true }),
  ];
  const stop = () => procs.forEach(p => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} });
  process.on('exit', stop);
  // Readiness checks are real requests too: count the ones that reached each service so the expected totals include them.
  const health = { 5300: 0, 5301: 0 };
  for (const port of [5300, 5301]) {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', `http://127.0.0.1:${port}/health`)).status === 200) { health[port]++; break; } } catch {} await sleep(200); }
  }
  await sleep(1000);

  // ---------- send the plan ----------
  const t0 = Date.now();
  const results = new Array(plan.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < plan.length) {
      const i = next++, kind = plan[i];
      const s = process.hrtime.bigint();
      const r = await req('GET', `http://127.0.0.1:5300/op/${kind}?rid=${i}`);
      results[i] = { i, kind, status: r.status, ms: Number(process.hrtime.bigint() - s) / 1e6, trace: r.headers['x-trace-id'] };
    }
  }));
  const t1 = Date.now();
  await sleep(1500);
  stop();
  // Rollups are buffered for up to 10 s and the agent batches for 200 ms; wait for both, plus the metric export (10 s).
  await sleep(25000);

  // ---------- query Monitoring ----------
  const login = await req('POST', `${DC}/api/auth/login`, { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  const cookie = Object.entries(Object.fromEntries((login.headers['set-cookie'] || []).map((c) => c.split(';')[0].split(/=(.*)/s).slice(0, 2)))).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  const api = async (method, p, body) => { const r = await req(method, `${DC}/api${p}`, body, { cookie }); if (r.status !== 200) throw new Error(`${p}: ${r.status} ${r.body.slice(0, 200)}`); return JSON.parse(r.body); };
  const from = Math.floor(t0 / 1000) - 60, to = Math.floor(Date.now() / 1000) + 60;
  const q = `from=${from}&to=${to}`;

  const checks = [];
  const check = (name, expected, actual, ok, note) => checks.push({ name, expected, actual, pass: !!ok, ...(note ? { note } : {}) });
  const truth = {};
  for (const [kind] of MIX) {
    const rs = results.filter(r => r.kind === kind);
    truth[kind] = { hits: rs.length, errors: rs.filter(r => r.status >= 500).length, p50: pctile(rs.map(r => r.ms), 0.5), p95: pctile(rs.map(r => r.ms), 0.95), p99: pctile(rs.map(r => r.ms), 0.99) };
  }
  const all = results.map(r => r.ms);
  const totalErrors = results.filter(r => r.status >= 500).length;

  // services list
  const services = await api('GET', `/ui/apm/services?${q}`);
  const gwRow = services.services.find(s => s.service === GW) || {};
  const tol = (truthMs, floorMs) => ({ lo: floorMs * 0.98, hi: truthMs * 1.02 + 2 });
  const latencyCheck = (name, dcNs, truthMs, floorMs) => {
    const dcMs = dcNs / 1e6, t = tol(truthMs, floorMs);
    check(name, `${floorMs.toFixed(1)}–${t.hi.toFixed(1)} ms (client ${truthMs.toFixed(1)} ms)`, `${dcMs.toFixed(1)} ms`, dcMs >= t.lo && dcMs <= t.hi);
  };
  const gwHits = N + health[5300];
  check(`service ${GW}: hits (${N} requests + ${health[5300]} health check)`, gwHits, gwRow.hits, gwRow.hits === gwHits);
  check(`service ${GW}: errors`, totalErrors, gwRow.errors, gwRow.errors === totalErrors);
  check(`service ${GW}: error rate`, +(totalErrors / gwHits).toFixed(5), gwRow.error_rate != null ? +gwRow.error_rate.toFixed(5) : null, Math.abs((gwRow.error_rate ?? -1) - totalErrors / gwHits) < 1e-9);
  // Floors for the mixed service distribution come from the injected sleeps at the same rank.
  const sleeps = plan.map(k => SLEEP_MS[k]);
  for (const p of [0.5, 0.95, 0.99]) latencyCheck(`service ${GW}: p${p * 100}`, gwRow[`p${p * 100}`], pctile(all, p), pctile(sleeps, p));
  const pyRow = services.services.find(s => s.service === PY) || {};
  check(`service ${PY}: hits (${truth.chain.hits} chained + ${health[5301]} health check)`, truth.chain.hits + health[5301], pyRow.hits, pyRow.hits === truth.chain.hits + health[5301]);

  // resources on the service page
  const page = await api('GET', `/ui/apm/services/${encodeURIComponent(GW)}?${q}`);
  const res = page.resources.find(r => /\/op\/:kind/.test(r.resource));
  check(`service page: resource GET /op/:kind present`, 'GET /op/:kind', res?.resource, !!res);
  check(`service page: resource hits`, N, res?.hits, res?.hits === N);
  check(`service page: downstream includes ${PY}`, PY, (page.downstream || []).map(d => d.service).join(','), (page.downstream || []).some(d => d.service === PY));
  const tsHits = (page.timeseries || []).reduce((s, b) => s + b.hits, 0);
  check(`service page: timeseries hits sum`, gwHits, tsHits, tsHits === gwHits);

  // per-kind latency and error checks from raw spans via the span search (same query surface as the UI)
  for (const [kind] of MIX) {
    const t = truth[kind];
    const spans = await api('POST', `/ui/apm/spans?${q}`, { query: `service:${GW} @http.target:"/op/${kind}*"`, limit: 1000, topLevelOnly: true });
    let rows = spans.spans;
    if (!rows.length || rows.length < t.hits) {
      // fall back to resource search on the route + filter by the rid's kind from meta url
      const s2 = await api('POST', `/ui/apm/spans?${q}`, { query: `service:${GW}`, limit: 1000, topLevelOnly: true });
      rows = s2.spans.filter(s => JSON.stringify(s.meta || {}).includes(`/op/${kind}`));
    }
    const durMs = rows.map(r => r.duration / 1e6);
    if (durMs.length) for (const p of [0.5, 0.95, 0.99]) latencyCheck(`spans /op/${kind}: p${p * 100}`, pctile(durMs, p) * 1e6, t[`p${p * 100}`], SLEEP_MS[kind]);
    const errs = rows.filter(r => r.error === 1).length;
    if (rows.length >= Math.min(t.hits, 1000)) check(`spans /op/${kind}: errors`, kind === 'fail' ? Math.min(t.hits, rows.length) : 0, errs, errs === (kind === 'fail' ? rows.length : 0));
  }

  // logs
  const logCount = async query => { const r = await api('POST', `/ui/logs/search?${q}`, { query, limit: 1 }); return r.total; };
  const gwLogs = await logCount(`service:${GW}`);
  check(`logs ${GW}: count`, N, gwLogs, gwLogs === N);
  const gwErr = await logCount(`service:${GW} status:error`);
  check(`logs ${GW}: status:error`, totalErrors, gwErr, gwErr === totalErrors);
  const pyLogs = await logCount(`service:${PY}`);
  check(`logs ${PY}: count`, truth.chain.hits, pyLogs, pyLogs === truth.chain.hits);
  // every gateway log links to a stored trace (checked in the database: the API exposes links per trace only)
  const linked = Number(execSync(`PGPASSWORD=monitoring psql -h localhost -U monitoring monitoring -tAc "select count(*) from logs l where l.service='${GW}' and l.ts >= ${t0 - 60000} and l.trace_id is not null and exists (select 1 from spans s where s.org_id=l.org_id and s.trace_id=l.trace_id and s.start_ms >= ${t0 - 60000})"`).toString().trim());
  check(`logs ${GW}: linked to a stored trace`, N, linked, linked === N);

  // sampled traces
  const chains = results.filter(r => r.kind === 'chain');
  const sample = chains.filter((_, k) => k % Math.max(1, Math.floor(chains.length / 60)) === 0).slice(0, 60);
  let complete = 0; const broken = [];
  for (const r of sample) {
    const t = await api('GET', `/ui/apm/traces/${r.trace}`);
    const ids = new Set(t.spans.map(s => s.span_id));
    const svcs = new Set(t.spans.map(s => s.service));
    const orphans = t.spans.filter(s => s.parent_id && s.parent_id !== '0' && !ids.has(s.parent_id)).length;
    const logsOk = t.logs.some(l => l.service === GW) && t.logs.some(l => l.service === PY);
    const dbSpan = t.spans.some(s => s.service === PY && /select/i.test(`${s.name} ${s.resource}`));
    if (svcs.has(GW) && svcs.has(PY) && !orphans && logsOk && dbSpan && t.spans.length >= 4) complete++;
    else broken.push({ trace: r.trace, spans: t.spans.length, services: [...svcs], orphans, logs: t.logs.length, dbSpan });
  }
  check(`traces (sample of ${sample.length} chain requests): both services, SQLite span, no orphan spans, both logs attached`, sample.length, complete, complete === sample.length, broken.length ? JSON.stringify(broken.slice(0, 3)) : undefined);

  // custom metric
  const m = await api('POST', `/ui/metrics/query?${q}`, { queries: [{ name: 'a', query: `sum:truth.requests{service:${GW}} by {kind}.as_count()` }] });
  for (const [kind] of MIX) {
    const s = m.series.find(x => x.group.includes(`kind:${kind}`));
    const total = s ? Math.round(s.pointlist.reduce((a, p) => a + (p[1] || 0), 0)) : 0;
    check(`metric truth.requests{kind:${kind}} sum`, truth[kind].hits, total, total === truth[kind].hits);
  }

  const passed = checks.filter(c => c.pass).length;
  const report = { run: RUN, services: [GW, PY], requests: N, window: [new Date(t0).toISOString(), new Date(t1).toISOString()], mix: Object.fromEntries(MIX),
    truth, passed, total: checks.length, checks };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch(e => { console.error(e.stack); process.exit(1); });
