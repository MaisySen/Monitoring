#!/usr/bin/env node
// Alert reliability test. Drives monitors with metrics whose values this script controls (sent straight to Monitoring's
// series API) and checks every notification that reaches the local webhook receiver (webhook-receiver.js on :5400).
//
//   node alerts.js > alerts-results.json
//
// Phases (monitors evaluate on the normal 30 s schedule; nothing forces an evaluation):
//   1 baseline          all values below threshold        -> no notifications
//   2 fire              A goes to 20                      -> exactly 1 "A firing"
//   3 restart in alert  server restarted while A alerts   -> A stays Alert, still exactly 1 "A firing" (no duplicate)
//   4 recover           A back to 1                       -> exactly 1 "A recovered"
//   5 change + restart  A fires again, then drops to 1 and the server is down for 45 s
//                       -> exactly 1 more firing and exactly 1 more recovery (none lost, none doubled)
//   6 missing data      metric N stops reporting          -> monitor B (notify_no_data) goes No Data with 1 notification;
//                                                           monitor C (same metric, notify_no_data off) stays OK, silent
//   7 retry             receiver fails the next 2 deliveries, D fires -> 2 x 503 then 1 x 200; log says "after 3 attempts"
//   8 retry + restart   receiver fails the next delivery, D recovers, server restarted before the retry is due
//                       -> retry still happens after the restart: 1 x 503 then 1 x 200, no duplicate
'use strict';
const env = require('../lib/env');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const DC = env.url();
const EMAIL = env.email();
const PASSWORD = env.password();
const API_KEY = env.apiKey();
const HOOKS = process.env.HOOK_FILE || path.join(require('os').tmpdir(), 'monitoring-webhooks.jsonl');
const RUN = process.env.RUN || Math.random().toString(36).slice(2, 7);
const M = (k) => `alerttest.${RUN}.${k}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return ''; } };

function req(method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url); const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', () => resolve({ status: 0, body: '' })); r.setTimeout(10000, () => r.destroy()); if (data) r.write(data); r.end();
  });
}
let cookie = '';
async function login() {
  const r = await req('POST', `${DC}/api/auth/login`, { email: EMAIL, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  cookie = Object.entries(Object.fromEntries((r.headers['set-cookie'] || []).map((c) => c.split(';')[0].split(/=(.*)/s).slice(0, 2)))).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function api(method, p, body) {
  for (let i = 0; i < 3; i++) {
    const r = await req(method, `${DC}/api${p}`, body, { cookie });
    if (r.status === 401) { await login(); continue; }
    if (r.status >= 200 && r.status < 300) return r.body ? JSON.parse(r.body) : {};
    if (i === 2) throw new Error(`${method} ${p}: ${r.status} ${r.body.slice(0, 200)}`);
    await sleep(2000);
  }
}

// ---- controlled metric values, sent every 5 s while set ----
const values = { a: 1, n: 1, d: 1 };
const sender = setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  const series = Object.entries(values).filter(([, v]) => v !== null).map(([k, v]) => ({ metric: M(k), points: [[now, v]], type: 'gauge', tags: ['test:alerts'] }));
  if (series.length) req('POST', `${DC}/api/v1/series`, { series }, { 'dd-api-key': API_KEY });
}, 5000);

// ---- helpers ----
const hooks = (path, since) => (fs.existsSync(HOOKS) ? fs.readFileSync(HOOKS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  .filter((h) => h.path === path && h.ts >= since);
const delivered = (path, since, re) => hooks(path, since).filter((h) => h.status === 200 && re.test(JSON.stringify(h.body)));
async function waitFor(desc, fn, timeoutMs) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) { const v = await fn(); if (v) return (Date.now() - t) / 1000; await sleep(2000); }
  return null;
}
async function state(id) { return (await api('GET', `/v1/monitor/${id}`)).overall_state; }
const SERVER = process.env.SERVER_PATTERN || '[n]ode --enable-source-maps artifacts/api-server/dist/index.mjs', LOOP = process.env.SERVER_LOOP_PATTERN || '[a]rtifacts/api-server && env';
const pidsOf = (p) => sh(`pgrep -f '${p}'`).split('\n').filter(Boolean).map(Number);
async function serverUp() { return (await req('GET', `${DC}/api/healthz`)).status === 200; }
async function restartServer(downMs = 0) {
  const loops = pidsOf(LOOP);
  if (downMs) loops.forEach((p) => process.kill(p, 'SIGSTOP'));
  pidsOf(SERVER).forEach((p) => process.kill(p, 'SIGKILL'));
  if (downMs) { await sleep(downMs); loops.forEach((p) => process.kill(p, 'SIGCONT')); }
  await sleep(1500);
  await waitFor('server up', serverUp, 60000);
  await login();
}
const results = [];
const check = (phase, name, expected, actual, pass, extra) => { const r = { phase, name, expected, actual, pass: !!pass, ...(extra || {}) }; results.push(r); process.stderr.write(JSON.stringify(r) + '\n'); };

(async () => {
  await login();
  // ---- setup ----
  const { channels } = await api('GET', '/ui/channels');
  for (const [name, path] of [['alerttest', '/alerttest'], ['alerttest-retry', '/alerttest-retry']])
    if (!channels.find((c) => c.name === name)) await api('POST', '/ui/channels', { kind: 'webhook', name, url: `http://127.0.0.1:5400${path}` });
  const mk = (name, query, message, options = {}) => api('POST', '/v1/monitor', { name: `${name} ${RUN}`, type: 'metric alert', query, message, options: { thresholds: { critical: 10 }, ...options } });
  const A = await mk('alerttest A', `avg(last_1m):avg:${M('a')}{*} > 10`, `{{#is_alert}}A firing {{value}}{{/is_alert}}{{#is_recovery}}A recovered{{/is_recovery}} @webhook-alerttest`);
  const B = await mk('alerttest B nodata-notify', `avg(last_1m):avg:${M('n')}{*} > 10`, `{{#is_no_data}}B no data{{/is_no_data}}{{#is_alert}}B firing{{/is_alert}}{{#is_recovery}}B recovered{{/is_recovery}} @webhook-alerttest`, { notify_no_data: true, no_data_timeframe: 2 });
  const C = await mk('alerttest C nodata-silent', `avg(last_1m):avg:${M('n')}{*} > 10`, `{{#is_no_data}}C no data{{/is_no_data}}{{#is_alert}}C firing{{/is_alert}}{{#is_recovery}}C recovered{{/is_recovery}} @webhook-alerttest`, { notify_no_data: false });
  const D = await mk('alerttest D retry', `avg(last_1m):avg:${M('d')}{*} > 10`, `{{#is_alert}}D firing{{/is_alert}}{{#is_recovery}}D recovered{{/is_recovery}} @webhook-alerttest-retry`);
  const t0 = Date.now();

  // 1 baseline
  await sleep(75000);
  check(1, 'all monitors OK with values below threshold', 'OK,OK,OK,OK', [await state(A.id), await state(B.id), await state(C.id), await state(D.id)].join(','),
    [A, B, C, D].length === 4 && (await state(A.id)) === 'OK' && (await state(D.id)) === 'OK');
  check(1, 'no notifications during baseline', 0, hooks('/alerttest', t0).length + hooks('/alerttest-retry', t0).length, hooks('/alerttest', t0).length + hooks('/alerttest-retry', t0).length === 0);

  // 2 fire
  let t = Date.now(); values.a = 20;
  const fired = await waitFor('A firing', async () => delivered('/alerttest', t, /A firing/).length >= 1, 150000);
  await sleep(35000);
  check(2, 'A fires and notifies exactly once', 1, delivered('/alerttest', t, /A firing/).length, delivered('/alerttest', t, /A firing/).length === 1, { seconds_to_notification: fired });
  check(2, 'A state', 'Alert', await state(A.id), (await state(A.id)) === 'Alert');

  // 3 restart while alerting
  const t3 = Date.now();
  await restartServer();
  await sleep(70000); // two evaluations after restart
  check(3, 'A still Alert after server restart', 'Alert', await state(A.id), (await state(A.id)) === 'Alert');
  check(3, 'no duplicate firing after restart', 0, delivered('/alerttest', t3, /A firing/).length, delivered('/alerttest', t3, /A firing/).length === 0);

  // 4 recover
  t = Date.now(); values.a = 1;
  const rec = await waitFor('A recovered', async () => delivered('/alerttest', t, /A recovered/).length >= 1, 180000);
  await sleep(35000);
  check(4, 'A recovers and notifies exactly once', 1, delivered('/alerttest', t, /A recovered/).length, delivered('/alerttest', t, /A recovered/).length === 1, { seconds_to_notification: rec });
  check(4, 'A state', 'OK', await state(A.id), (await state(A.id)) === 'OK');

  // 5 transition across a restart
  t = Date.now(); values.a = 20;
  await waitFor('A firing again', async () => delivered('/alerttest', t, /A firing/).length >= 1, 150000);
  const t5 = Date.now(); values.a = 1;
  await sleep(6000); // let one low point land, then take the server down
  await restartServer(45000);
  const rec5 = await waitFor('A recovered after restart', async () => delivered('/alerttest', t5, /A recovered/).length >= 1, 180000);
  await sleep(35000);
  check(5, 'firing during phase 5 delivered exactly once', 1, delivered('/alerttest', t, /A firing/).length, delivered('/alerttest', t, /A firing/).length === 1);
  check(5, 'recovery that happened across a 45 s outage delivered exactly once', 1, delivered('/alerttest', t5, /A recovered/).length, delivered('/alerttest', t5, /A recovered/).length === 1, { seconds_to_notification: rec5 });

  // 6 missing data
  t = Date.now(); values.n = null;
  const nd = await waitFor('B no data', async () => delivered('/alerttest', t, /B no data/).length >= 1, 240000);
  await sleep(35000);
  check(6, 'B (notify_no_data) notifies No Data exactly once', 1, delivered('/alerttest', t, /B no data/).length, delivered('/alerttest', t, /B no data/).length === 1, { seconds_to_notification: nd });
  check(6, 'B state', 'No Data', await state(B.id), (await state(B.id)) === 'No Data');
  check(6, 'C (notify_no_data off) stays OK and silent', 'OK, 0 notifications', `${await state(C.id)}, ${delivered('/alerttest', t, /C /).length} notifications`,
    (await state(C.id)) === 'OK' && delivered('/alerttest', t, /C /).length === 0);

  // 7 retry
  await req('POST', 'http://127.0.0.1:5400/control', { fail: 2 });
  t = Date.now(); values.d = 20;
  const ok7 = await waitFor('D delivered', async () => delivered('/alerttest-retry', t, /D firing/).length >= 1, 240000);
  await sleep(15000);
  const h7 = hooks('/alerttest-retry', t).filter((h) => /D firing/.test(JSON.stringify(h.body)));
  const log7 = (await api('GET', `/ui/monitors/${D.id}/history`)).notifications.find((n) => n.channel === '@webhook-alerttest-retry' && n.ts >= t);
  check(7, 'D firing: 2 failed attempts then delivered once', '503,503,200', h7.map((h) => h.status).join(','), h7.map((h) => h.status).join(',') === '503,503,200', { seconds_to_delivery: ok7, log: log7 && `${log7.status}: ${log7.detail}` });

  // 8 retry pending across a restart
  await req('POST', 'http://127.0.0.1:5400/control', { fail: 1 });
  t = Date.now(); values.d = 1;
  await waitFor('first recovery attempt (fails)', async () => hooks('/alerttest-retry', t).some((h) => /D recovered/.test(JSON.stringify(h.body))), 180000);
  await restartServer(); // the retry is due 10 s after the failure; the server is restarted before that
  const ok8 = await waitFor('D recovery delivered after restart', async () => delivered('/alerttest-retry', t, /D recovered/).length >= 1, 120000);
  await sleep(30000);
  const h8 = hooks('/alerttest-retry', t).filter((h) => /D recovered/.test(JSON.stringify(h.body)));
  check(8, 'retry survives a restart: 1 failed attempt, then delivered once', '503,200', h8.map((h) => h.status).join(','), h8.map((h) => h.status).join(',') === '503,200', { seconds_to_delivery: ok8 });

  clearInterval(sender);
  // clean up the test monitors
  for (const m of [A, B, C, D]) await api('DELETE', `/v1/monitor/${m.id}`).catch(() => {});
  const passed = results.filter((r) => r.pass).length;
  console.log(JSON.stringify({ run: RUN, passed, total: results.length, results }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
