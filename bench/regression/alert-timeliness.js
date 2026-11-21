// Alert-evaluation timeliness under load and recovery after overload (bounded, disposable org only).
// Thresholds are test choices, justified inline — not production SLAs.
//   idle: first evaluation within 90s of creation (tick is 30s; 3 ticks = clearly broken)
//   load (400 traces/s, 4 min): staleness stays <= 120s (4 missed 30s ticks = broken on a healthy 1-core box)
//   overload (800 traces/s, 2 min): recorded, no assertion (known breaking point on this box)
//   recovery: staleness back <= 120s within 3 min of load stop
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const env = require('../lib/env');
const BASE = env.url(), KEY = env.apiKey();
const DB = process.env.DATABASE_URL;
const OUT = process.env.OUT || path.join(__dirname, '..', 'evidence', `timeliness-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (q) => execSync(`psql "${DB}" -tAc "set jit=off; ${q.replace(/"/g, '\\"')}"`, { env: { ...process.env, PATH: `/usr/lib/postgresql/14/bin:${process.env.PATH}` } }).toString().trim();
const samples = [];
const rec = (phase, extra = {}) => { const s = { t: new Date().toISOString(), phase, ...extra }; samples.push(s); fs.appendFileSync(path.join(OUT, 'timeliness.jsonl'), JSON.stringify(s) + '\n'); return s; };
let cookie = '';
async function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: new URL(BASE).hostname, port: new URL(BASE).port, path: `/api${p}`, method, headers: { 'content-type': 'application/json', cookie, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { if (res.headers['set-cookie']) { const jar = Object.fromEntries(cookie ? cookie.split('; ').map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }) : []); for (const c of res.headers['set-cookie']) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i)] = pair.slice(i + 1); } cookie = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; '); } resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); }); });
    r.on('error', () => resolve({ status: 0, body: null })); if (data) r.write(data); r.end();
  });
}
function loadgen(tps, seconds) {
  const p = spawn('node', [path.join(__dirname, '..', 'scale', 'loadgen.js')], { env: { ...process.env, MONITORING_API_KEY: KEY, RUN: `timeliness-${Date.now()}`, TRACES_PER_S: String(tps), SECONDS: String(seconds), CONCURRENCY: '8' }, stdio: 'ignore' });
  return p;
}
async function staleness(id) {
  return Number(psql(`select coalesce(extract(epoch from now())*1000 - last_evaluated_at, -1)::bigint from monitors where id=${id}`));
}
(async () => {
  const summary = { thresholds: { idle_first_eval_ms: 90000, load_staleness_ms: 120000, recovery_within_ms: 180000 }, checks: [] };
  const check = (name, pass, detail) => { summary.checks.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} [${name}] ${detail}`); };
  await req('POST', '/auth/login', { email: env.email(), password: env.password() });
  // probe monitor over the loadgen data (real eval work, stays OK)
  const m = await req('POST', '/v1/monitor', { name: `timeliness probe ${Date.now()}`, type: 'trace-analytics alert', query: 'spans("env:scale status:error").last("5m") > 100000000', message: 'timeliness probe', options: { thresholds: { critical: 100000000 } } });
  const id = m.body.id;
  const t0 = Date.now();
  // phase 1: idle first evaluation
  let first = -1;
  while (Date.now() - t0 < 120000) { const s = await staleness(id); if (s >= 0) { first = Date.now() - t0; break; } await sleep(5000); }
  rec('idle', { first_eval_after_ms: first });
  check('idle-first-eval', first >= 0 && first <= summary.thresholds.idle_first_eval_ms, `first evaluation ${first}ms after creation (limit 90000)`);
  // phase 2: load 400 tps, 4 min
  const lg1 = loadgen(400, 240);
  let maxStale = 0;
  for (let i = 0; i < 8; i++) { await sleep(30000); const s = await staleness(id); maxStale = Math.max(maxStale, s); rec('load', { staleness_ms: s }); }
  await new Promise((r) => lg1.on('exit', r));
  check('load-staleness', maxStale <= summary.thresholds.load_staleness_ms, `max staleness under 400 traces/s: ${maxStale}ms (limit 120000)`);
  // phase 3: overload 800 tps, 2 min (record only)
  const lg2 = loadgen(800, 120);
  let maxOverload = 0;
  for (let i = 0; i < 4; i++) { await sleep(30000); const s = await staleness(id); maxOverload = Math.max(maxOverload, s); rec('overload', { staleness_ms: s }); }
  await new Promise((r) => lg2.on('exit', r));
  // phase 4: recovery
  const t1 = Date.now();
  let recovered = -1;
  while (Date.now() - t1 < summary.thresholds.recovery_within_ms + 60000) { const s = await staleness(id); rec('recovery', { staleness_ms: s }); if (s >= 0 && s <= summary.thresholds.load_staleness_ms) { recovered = Date.now() - t1; break; } await sleep(15000); }
  summary.overload_max_staleness_ms = maxOverload;
  check('recovery', recovered >= 0 && recovered <= summary.thresholds.recovery_within_ms, `staleness <=120s again ${recovered}ms after load stop (limit 180000); overload peak ${maxOverload}ms`);
  await req('DELETE', `/v1/monitor/${id}`);
  summary.pass = summary.checks.every((c) => c.pass);
  fs.writeFileSync(path.join(OUT, 'timeliness-summary.json'), JSON.stringify(summary, null, 2));
  console.log(summary.pass ? 'ALL PASS' : 'FAILED');
  process.exit(summary.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
