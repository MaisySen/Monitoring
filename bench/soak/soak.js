#!/usr/bin/env node
// Sustained-scale soak + ramp test. Ingestion, UI queries and monitors run together for SOAK_HOURS, with resource use,
// latency and loss tracked over time; then a ramp raises the ingest rate step by step until something breaks.
//
//   SOAK_HOURS=3 node bench/soak/soak.js            (writes bench/soak/out/<run>/...)
//   RAMP_ONLY=1 node bench/soak/soak.js
//
// Load: bench/scale/loadgen.js direct to intake (200 hosts, 50 services, 400 traces/s ≈ 2,400 spans/s + ~400 logs/s,
// host metrics every 15 s, a 20,000-customer metric). Every record carries loadtest.run so stored counts can be checked.
// Every minute: server and Postgres CPU/RSS, DB size, rows inserted, monitor evaluation staleness. Every 5 minutes: the
// API calls behind each core screen (bench/scale/query-probe.sh). 20 monitors evaluate on their normal 30 s schedule.
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const HOURS = Number(process.env.SOAK_HOURS || 3);
const RUN = process.env.RUN || `soak-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
const OUT = path.join(__dirname, 'out', RUN);
fs.mkdirSync(OUT, { recursive: true });
const env = require('../lib/env');
const KEY = env.apiKey();
const PASSWORD = env.password();
const DC = env.url();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, t = 120000) => { try { return execSync(c, { encoding: 'utf8', timeout: t, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return ''; } };
// psql reads the same DATABASE_URL the server uses, so the soak runs against any deployment.
const DBURL = env.databaseUrl();
const psql = (q, t) => sh(`PATH=/usr/lib/postgresql/14/bin:$PATH psql "${DBURL}" -tAc "${q.replace(/"/g, '\\"')}"`, t);
// Org owning the intake key: loss counts must be scoped to it, never to a hardcoded org id.
const ORG = Number(sh(`PATH=/usr/lib/postgresql/14/bin:$PATH psql "${DBURL}" -tAc "select org_id from api_keys where key = '${env.apiKey()}'"`)) || 1;
const append = (f, o) => fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + '\n');
const TICK = Number(sh('getconf CLK_TCK')) || 100;

function req(method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url); const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', () => resolve({ status: 0, body: '' })); r.setTimeout(30000, () => r.destroy()); if (data) r.write(data); r.end();
  });
}
let cookie = '';
async function login() {
  const r = await req('POST', `${DC}/api/auth/login`, { email: env.email(), password: PASSWORD });
  cookie = Object.entries(Object.fromEntries((r.headers['set-cookie'] || []).map((c) => c.split(';')[0].split(/=(.*)/s).slice(0, 2)))).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
}
const api = async (m, p, b) => { let r = await req(m, `${DC}/api${p}`, b, { cookie }); if (r.status === 401) { await login(); r = await req(m, `${DC}/api${p}`, b, { cookie }); } return r.body ? JSON.parse(r.body) : {}; };

// ---- process sampling ----
const cpuTicks = (pids) => pids.reduce((s, p) => { try { const f = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' '); return s + Number(f[11]) + Number(f[12]); } catch { return s; } }, 0);
const rssMb = (pids) => pids.reduce((s, p) => { try { return s + Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'))[1]) / 1024; } catch { return s; } }, 0);
const pidsOf = (pattern) => sh(`pgrep -f '${pattern}'`).split('\n').filter(Boolean).map(Number);
// machine-wide CPU from /proc/stat (visible from any process namespace): busy share of all cores, and core count
const sysCpu = () => { const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); const idle = f[3] + (f[4] || 0); return { busy: f.reduce((a, b) => a + b, 0) - idle, total: f.reduce((a, b) => a + b, 0) }; };
const CORES = fs.readFileSync('/proc/stat', 'utf8').split('\n').filter((l) => /^cpu\d+ /.test(l)).length;
let prev = null;
function sample(extra = {}) {
  const server = pidsOf('[n]ode --enable-source-maps artifacts/api-server/dist/index.mjs'), pg = pidsOf('[p]ostgres'), agent = pidsOf('[d]atacat-agent run');
  const now = Date.now(), cur = { now, server: cpuTicks(server), pg: cpuTicks(pg), agent: cpuTicks(agent), sys: sysCpu() };
  const ins = psql("select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables where relname in ('spans','logs','metric_points')");
  const stale = psql("select coalesce(max(extract(epoch from now())*1000 - last_evaluated_at),0)::bigint from monitors where name like 'soak %'");
  const s = { t: new Date(now).toISOString(), elapsed_min: Math.round((now - t0) / 60000),
    server_rss_mb: Math.round(rssMb(server)), pg_rss_mb: Math.round(rssMb(pg)),
    db_size_mb: Math.round(Number(psql("select pg_database_size(current_database())")) / 1048576),
    monitor_eval_staleness_s: Math.round(Number(stale) / 1000), rows_inserted_total: Number(ins), ...extra };
  if (prev) {
    const dt = (now - prev.now) / 1000;
    s.server_cpu_pct = Math.round(100 * (cur.server - prev.server) / TICK / dt);
    s.pg_cpu_pct = Math.round(100 * (cur.pg - prev.pg) / TICK / dt);
    s.rows_inserted_per_s = Math.round((Number(ins) - prev.ins) / dt);
    s.machine_cpu_pct = Math.round(100 * (cur.sys.busy - prev.sys.busy) / Math.max(1, cur.sys.total - prev.sys.total)); s.cores = CORES;
  }
  prev = { ...cur, ins: Number(ins) };
  return s;
}

function loadgen(run, tps, seconds) {
  const p = spawn('node', [path.join(__dirname, '..', 'scale', 'loadgen.js')], {
    env: { ...process.env, MONITORING_API_KEY: KEY, RUN: run, TRACES_PER_S: String(tps), SECONDS: String(seconds), CONCURRENCY: '8' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let final = '', lastStat = null;
  p.stdout.on('data', (d) => (final += d));
  p.stderr.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { try { const j = JSON.parse(l); if (j.t !== undefined) { lastStat = j; append(`loadgen-${run}.jsonl`, { ...j, wall: new Date().toISOString() }); } } catch { append(`loadgen-${run}.jsonl`, { msg: l }); } } });
  return { proc: p, done: new Promise((r) => p.on('exit', () => r(JSON.parse(final.trim().split('\n').pop() || '{}')))), last: () => lastStat };
}

async function createMonitors() {
  const existing = await api('GET', '/v1/monitor');
  for (const m of (Array.isArray(existing) ? existing : existing.monitors || [])) if (m.name.startsWith('soak ')) await api('DELETE', `/v1/monitor/${m.id}`);
  const defs = [];
  for (let i = 0; i < 8; i++) defs.push({ name: `soak trace errors svc-${String(i).padStart(2, '0')}`, type: 'trace-analytics alert', query: `spans("env:scale service:svc-${String(i).padStart(2, '0')} status:error").last("5m") > 100000` });
  for (let i = 0; i < 4; i++) defs.push({ name: `soak log errors svc-${String(i).padStart(2, '0')}`, type: 'log alert', query: `logs("service:svc-${String(i).padStart(2, '0')} status:error").index("*").rollup("count").last("5m") > 100000` });
  defs.push({ name: 'soak host load by host', type: 'metric alert', query: 'avg(last_5m):avg:system.load.1{*} by {host} > 1000' });
  defs.push({ name: 'soak cpu by host', type: 'metric alert', query: 'avg(last_5m):avg:system.cpu.user{*} by {host} > 1000' });
  defs.push({ name: 'soak errors by service', type: 'trace-analytics alert', query: 'spans("env:scale status:error").by("service").last("5m") > 100000' });
  defs.push({ name: 'soak orders by plan', type: 'metric alert', query: 'sum(last_5m):sum:scale.orders.placed{*} by {plan}.as_count() < 0' });
  defs.push({ name: 'soak logs volume', type: 'log alert', query: 'logs("env:scale").index("*").rollup("count").last("5m") > 100000000' });
  defs.push({ name: 'soak spans volume', type: 'trace-analytics alert', query: 'spans("env:scale").last("5m") > 100000000' });
  // two with a known, steady expected state for the whole soak: always alerting / never alerting
  defs.push({ name: 'soak expected ALERT', type: 'trace-analytics alert', query: 'spans("env:scale status:error").last("5m") > 10' });
  defs.push({ name: 'soak expected OK', type: 'trace-analytics alert', query: 'spans("env:scale status:error service:does-not-exist").last("5m") > 10' });
  const ids = [];
  for (const d of defs) { const m = await api('POST', '/v1/monitor', { ...d, message: 'soak test (in-app only)', options: { thresholds: { critical: Number(/[\d.]+$/.exec(d.query)[0]) } } }); ids.push(m.id); }
  return ids;
}

let t0 = Date.now();
(async () => {
  await login();
  const summary = { run: RUN, hours: HOURS };
  if (!process.env.RAMP_ONLY) {
    const monitorIds = await createMonitors();
    summary.monitors = monitorIds.length;
    t0 = Date.now();
    const lg = loadgen(RUN, Number(process.env.TPS || 400), Math.round(HOURS * 3600));
    sample();
    const iv = setInterval(() => { const l = lg.last(); append('samples.jsonl', sample(l ? { intake_p50_ms: l.intake_p50_ms, intake_p99_ms: l.intake_p99_ms, loadgen_errors: l.errors, loadgen_inflight: l.inflight } : {})); }, 60000);
    const probe = async () => { const out = sh(`bash ${path.join(__dirname, '..', 'scale', 'query-probe.sh')} t${Math.round((Date.now() - t0) / 60000)}`, 240000); for (const l of out.split('\n').filter(Boolean)) { try { append('probes.jsonl', JSON.parse(l)); } catch {} } };
    const pv = setInterval(probe, 300000); setTimeout(probe, 120000);
    const sent = await lg.done;
    clearInterval(iv); clearInterval(pv);
    summary.sent = sent;
    // monitor stability: state changes recorded during the soak
    const evs = psql(`select m.name, count(e.*) from monitors m left join events e on e.monitor_id = m.id and e.ts >= ${t0} where m.name like 'soak %' group by 1 order by 1`);
    summary.monitor_events = Object.fromEntries(evs.split('\n').filter(Boolean).map((l) => { const [n, c] = l.split('|'); return [n, Number(c)]; }));
    summary.monitor_states = Object.fromEntries(psql("select name, overall_state from monitors where name like 'soak %' order by name").split('\n').filter(Boolean).map((l) => l.split('|')));
    await sleep(30000);
    // loss check (stored vs sent), by loadtest.run
    const spans = psql(`select count(*) from spans where org_id=${ORG} and start_ms >= ${t0 - 60000} and meta->>'loadtest.run' = '${RUN}'`, 1800000);
    const logs = psql(`select count(*) from logs where org_id=${ORG} and ts >= ${t0 - 60000} and tags @> array['loadtest.run:${RUN}']`, 1800000);
    summary.stored = { spans: Number(spans), logs: Number(logs) };
    summary.loss = { spans: sent.sent ? sent.sent.spans - Number(spans) : null, logs: sent.sent ? sent.sent.logs - Number(logs) : null };
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  // ---- ramp: raise the rate until achieved < 95% of target, intake p99 > 2 s, or errors appear ----
  const steps = (process.env.RAMP || '400,800,1200,1600,2400,3200,4800').split(',').map(Number);
  summary.ramp = [];
  for (const tps of steps) {
    const run = `${RUN}-ramp${tps}`;
    prev = null; sample();
    const lg = loadgen(run, tps, 180);
    const samples = [];
    const iv = setInterval(() => samples.push(sample()), 30000);
    const sent = await lg.done;
    clearInterval(iv);
    const stats = fs.readFileSync(path.join(OUT, `loadgen-${run}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((j) => j.t !== undefined && j.t >= 30);
    // sustained p99: the 90th percentile of the 10-second p99 windows (one stalled batch does not end the ramp); worst window kept too
    const w = stats.map((s) => s.intake_p99_ms).sort((a, b) => a - b);
    const p99 = w.length ? w[Math.min(w.length - 1, Math.floor(w.length * 0.9))] : 0;
    const p99Worst = w.length ? w[w.length - 1] : 0;
    const target = tps * 6; // ≈ spans per trace
    const step = { traces_per_s_target: tps, spans_per_s_achieved: sent.rate?.spans_per_s, logs_per_s_achieved: sent.rate?.logs_per_s, achieved_vs_target_traces: +(sent.sent?.spans / 180 / (tps * (sent.sent?.spans / Math.max(1, sent.sent?.logs) > 0 ? 1 : 1)) || 0).toFixed(2),
      intake_p99_ms_sustained: p99, intake_p99_ms_worst_window: p99Worst, intake_p50_ms_median: (stats.map((s) => s.intake_p50_ms).sort((a, b) => a - b)[Math.floor(stats.length / 2)] || 0), errors: sent.errors, machine_cpu_pct_max: Math.max(...samples.map((s) => s.machine_cpu_pct || 0)), cores: CORES, server_cpu_pct_max: Math.max(...samples.map((s) => s.server_cpu_pct || 0)), pg_cpu_pct_max: Math.max(...samples.map((s) => s.pg_cpu_pct || 0)),
      monitor_staleness_s_max: Math.max(...samples.map((s) => s.monitor_eval_staleness_s || 0)) };
    // achieved trace rate: logs ≈ 1.02 per trace, so traces/s ≈ logs/s / 1.02
    step.traces_per_s_achieved = Math.round((sent.rate?.logs_per_s || 0) / 1.02);
    step.achieved_ratio = +(step.traces_per_s_achieved / tps).toFixed(2);
    summary.ramp.push(step);
    append('ramp.jsonl', step);
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    if (step.achieved_ratio < 0.95 || p99 > Number(process.env.RAMP_P99_LIMIT || 2000) || sent.errors > 0) { step.breaking = true; break; }
    await sleep(30000);
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
