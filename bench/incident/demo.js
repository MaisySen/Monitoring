#!/usr/bin/env node
// Scripted incident for the Acme Shop on the Monitoring stack: inject a faulty query, prove the alert -> service -> trace ->
// faulty query + logs path with data from Monitoring's own APIs, and time each step.
//
//   node demo.js            set up channel + monitor, inject the fault, wait for alert + webhook, collect evidence
//   node demo.js --recover  remove the fault, wait for recovery + recovery webhook
//
// Needs: the Acme Shop example running (examples/acme-shop), the webhook receiver (webhook-receiver.js), and a
// Monitoring login (MONITORING_EMAIL / MONITORING_PASSWORD). Writes evidence to $OUT (default incident-evidence.json / -recovery.json).
'use strict';
const env = require('../lib/env');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const DC = env.url();
const EMAIL = env.email();
const PASSWORD = env.password();
const HOOK_FILE = process.env.HOOK_FILE || path.join(require('os').tmpdir(), 'monitoring-webhooks.jsonl');
const RECOVER = process.argv.includes('--recover');
const MONITOR_NAME = 'Checkout path errors by service';
// Alert when any Acme service records more than THRESHOLD error spans in 2 minutes (normal maximum about 40, from shop-api; the incident produces about 250). Scoped to the
// team's own services (team:acme), the way a team would scope its alerts; other apps in the org are out of scope.
const THRESHOLD = Number(process.env.THRESHOLD || 60); // normal max ~40 per 2 min (shop-api), incident ~250
const MON_QUERY = `spans("env:prod team:acme status:error").by("service").last("2m") > ${THRESHOLD}`;
// The scheduler evaluates monitors every 30 s; detection times below are measured on that schedule (no forced evaluation).
const FORCE_EVAL = process.env.FORCE_EVAL === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
let cookie = '';
async function api(method, p, body) {
  const r = await req(method, `${DC}/api${p}`, body, { cookie });
  if (r.status >= 300) throw new Error(`${method} ${p}: ${r.status} ${r.body.slice(0, 300)}`);
  return r.body ? JSON.parse(r.body) : {};
}
function hooksSince(ts) {
  if (!fs.existsSync(HOOK_FILE)) return [];
  return fs.readFileSync(HOOK_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((h) => h.ts >= ts && h.path === '/incident');
}

(async () => {
  const login = await req('POST', `${DC}/api/auth/login`, { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  cookie = Object.entries(Object.fromEntries((login.headers['set-cookie'] || []).map((c) => c.split(';')[0].split(/=(.*)/s).slice(0, 2)))).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');

  // channel + monitor (idempotent)
  const { channels } = await api('GET', '/ui/channels');
  if (!channels.find((c) => c.name === 'incident-demo')) await api('POST', '/ui/channels', { kind: 'webhook', name: 'incident-demo', url: 'http://127.0.0.1:5400/incident' });
  const monitors = await api('GET', '/v1/monitor');
  let mon = (Array.isArray(monitors) ? monitors : monitors.monitors || []).find((m) => m.name === MONITOR_NAME);
  if (!mon) {
    mon = await api('POST', '/v1/monitor', {
      name: MONITOR_NAME, type: 'trace-analytics alert',
      query: MON_QUERY,
      message: '{{#is_alert}}{{service.name}} is failing: {{value}} error spans in 2 minutes. Open the monitor for the failing traces and logs.{{/is_alert}}{{#is_recovery}}{{service.name}} recovered.{{/is_recovery}} @webhook-incident-demo',
      options: { thresholds: { critical: THRESHOLD }, notify_no_data: false, evaluation_delay: 0 },
    });
  }
  if (mon.query !== MON_QUERY) mon = await api('PUT', `/v1/monitor/${mon.id}`, { type: 'trace-analytics alert', query: MON_QUERY, options: { thresholds: { critical: THRESHOLD }, notify_no_data: false } });
  const id = mon.id;
  const t0 = Date.now();

  if (!RECOVER) {
    const before = await api('GET', `/v1/monitor/${id}`);
    execSync(`bash ${path.join(__dirname, 'inject.sh')} on`);
    let alertAt = null, hookAt = null, state;
    for (let i = 0; i < 60 && (!alertAt || !hookAt); i++) {
      await sleep(5000);
      if (FORCE_EVAL) { try { await api('POST', `/ui/monitors/${id}/evaluate`, {}); } catch {} }
      state = await api('GET', `/v1/monitor/${id}`);
      if (!alertAt && state.overall_state === 'Alert') alertAt = Date.now();
      const h = hooksSince(t0).find((x) => /failing/.test(JSON.stringify(x.body)));
      if (!hookAt && h) hookAt = h.ts;
    }
    // Evidence a responder follows: the alerting groups, the failing spans and their faulty query, one full trace and its logs.
    const from = Math.floor(t0 / 1000) - 60, to = Math.floor(Date.now() / 1000) + 5, q = `from=${from}&to=${to}`;
    const alerting = Object.entries(state.group_states || {}).filter(([, g]) => g.state === 'Alert').map(([k, g]) => ({ group: k, value: g.value }));
    const cartErrs = await api('POST', `/ui/apm/spans?${q}`, { query: 'service:cart-service status:error', limit: 200 });
    const dbErr = cartErrs.spans.find((s) => (s.meta || {})['db.statement'] || (s.meta || {})['db.query.text'] || s.type === 'sql' || /pg|postgres/i.test(s.name));
    let trace = null;
    const gwErr = (await api('POST', `/ui/apm/spans?${q}`, { query: 'service:web-gateway status:error resource_name:"POST /checkout"', limit: 20, topLevelOnly: true })).spans[0];
    if (gwErr) {
      const t = await api('GET', `/ui/apm/traces/${gwErr.trace_id}`);
      trace = { trace_id: gwErr.trace_id, spans: t.spans.map((s) => ({ service: s.service, name: s.name, resource: s.resource, error: s.error, parent_id: s.parent_id, span_id: s.span_id,
        statement: (s.meta || {})['db.statement'] || (s.meta || {})['db.query.text'], message: (s.meta || {})['error.message'] || (s.meta || {})['otel.status_description'] })),
        logs: t.logs.map((l) => ({ service: l.service, status: l.status, message: l.message })) };
    }
    const errLogs = await api('POST', `/ui/logs/search?${q}`, { query: 'service:cart-service status:error', limit: 3 });
    const ev = {
      injected_at: new Date(t0).toISOString(), monitor_id: id, monitor_query: mon.query, state_before: before.overall_state,
      seconds_to_alert: alertAt ? (alertAt - t0) / 1000 : null, seconds_to_webhook: hookAt ? (hookAt - t0) / 1000 : null,
      alerting_groups: alerting,
      webhook: hooksSince(t0).slice(0, 2).map((h) => ({ ts: new Date(h.ts).toISOString(), status: h.status, body: h.body })),
      cart_error_spans: cartErrs.total, faulty_db_span: dbErr ? { name: dbErr.name, resource: dbErr.resource, statement: dbErr.meta?.['db.statement'] || dbErr.meta?.['db.query.text'], message: dbErr.meta?.['error.message'] || dbErr.meta?.['otel.status_description'], trace_id: dbErr.trace_id } : null,
      example_checkout_trace: trace,
      cart_error_logs: { total: errLogs.total, sample: errLogs.logs.map((l) => ({ message: l.message, trace_id: l.trace_id })) },
    };
    fs.writeFileSync(process.env.OUT || path.join(__dirname, 'incident-evidence.json'), JSON.stringify(ev, null, 2));
    console.log(JSON.stringify({ seconds_to_alert: ev.seconds_to_alert, seconds_to_webhook: ev.seconds_to_webhook, alerting_groups: alerting, faulty_query: ev.faulty_db_span?.statement, error: ev.faulty_db_span?.message, trace_spans: trace?.spans.length, trace_logs: trace?.logs.length }, null, 2));
  } else {
    execSync(`bash ${path.join(__dirname, 'inject.sh')} off`);
    let okAt = null, hookAt = null, state;
    for (let i = 0; i < 72 && (!okAt || !hookAt); i++) {
      await sleep(5000);
      if (FORCE_EVAL) { try { await api('POST', `/ui/monitors/${id}/evaluate`, {}); } catch {} }
      state = await api('GET', `/v1/monitor/${id}`);
      if (!okAt && state.overall_state === 'OK') okAt = Date.now();
      const h = hooksSince(t0).find((x) => /recovered/.test(JSON.stringify(x.body)));
      if (!hookAt && h) hookAt = h.ts;
    }
    const ev = { fixed_at: new Date(t0).toISOString(), seconds_to_ok: okAt ? (okAt - t0) / 1000 : null, seconds_to_recovery_webhook: hookAt ? (hookAt - t0) / 1000 : null,
      final_state: state.overall_state, webhook: hooksSince(t0).slice(0, 3).map((h) => ({ ts: new Date(h.ts).toISOString(), status: h.status, body: h.body })) };
    fs.writeFileSync(process.env.OUT || path.join(__dirname, 'incident-recovery.json'), JSON.stringify(ev, null, 2));
    console.log(JSON.stringify(ev, null, 2));
  }
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
