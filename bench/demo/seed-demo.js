#!/usr/bin/env node
// Seeds a fresh Monitoring server with a realistic demo environment for the M4 end-to-end
// journey and UI screenshots.
//
//   MONITORING_URL=http://127.0.0.1:4610 MONITORING_SETUP_TOKEN=... node bench/demo/seed-demo.js
//
// Creates: admin account + org "Acme Production", an API key, three services with traces,
// logs and metrics over the last ~30 minutes, a dashboard, a webhook notification channel,
// a metric monitor driven into Alert (with a real webhook delivery), and a second org
// "Acme Staging" with its own small dataset so the org switcher has real content.
// Prints a DEMO_SUMMARY JSON line with the created ids for the screenshot script.
'use strict';
const http = require('http');
const crypto = require('crypto');

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:4610';
const SETUP = process.env.MONITORING_SETUP_TOKEN;
const SINK_PORT = Number(process.env.DEMO_SINK_PORT || 5409);
const ADMIN = { email: 'demo@acme.test', password: 'Demo-pass-12345', name: 'Demo Admin' };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ns = (ms) => String(BigInt(ms) * 1000000n);

const SERVICES = [
  { name: 'web-frontend', hosts: ['web-1', 'web-2'], base: 120, routes: ['GET /', 'GET /products', 'GET /checkout'] },
  { name: 'api-gateway', hosts: ['api-1'], base: 200, routes: ['GET /api/orders', 'POST /api/orders', 'GET /api/users'] },
  { name: 'job-worker', hosts: ['worker-1'], base: 40, routes: ['process-order', 'send-receipt'] },
];

function trace(service, route, tMs, error) {
  const traceId = crypto.randomBytes(16).toString('hex');
  const rootId = crypto.randomBytes(8).toString('hex');
  const dur = 20 + Math.floor(Math.random() * (error ? 900 : 180));
  const mk = (id, parent, name, kind) => ({
    traceId, spanId: id, parentSpanId: parent, name, kind,
    startTimeUnixNano: ns(tMs), endTimeUnixNano: ns(tMs + dur),
    attributes: [{ key: 'http.route', value: { stringValue: route } }],
    ...(error ? { status: { code: 2 } } : {}),
  });
  const spans = [mk(rootId, undefined, route, 2)];
  if (Math.random() < 0.6) spans.push(mk(crypto.randomBytes(8).toString('hex'), rootId, 'pg query', 3));
  return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service.name } }, { key: 'host.name', value: { stringValue: service.hosts[0] } }, { key: 'deployment.environment', value: { stringValue: 'production' } }] }, scopeSpans: [{ scope: { name: 'demo' }, spans }] }] };
}
function logs(service, tMs, n) {
  const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
  const msgs = { INFO: 'request completed', WARN: 'slow upstream response', ERROR: 'upstream connection reset' };
  const recs = [];
  for (let i = 0; i < n; i++) {
    const sev = levels[Math.floor(Math.random() * levels.length)];
    recs.push({ timeUnixNano: ns(tMs + i * 137), severityText: sev, body: { stringValue: `${msgs[sev]} (${service.name})` } });
  }
  return { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service.name } }] }, scopeLogs: [{ scope: { name: 'demo' }, logRecords: recs }] }] };
}
function metric(service, name, points) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service.name } }, { key: 'host.name', value: { stringValue: service.hosts[0] } }] }, scopeMetrics: [{ scope: { name: 'demo' }, metrics: [{ name, gauge: { dataPoints: points.map(([t, v]) => ({ timeUnixNano: ns(t), asDouble: v })) } }] }] }] };
}

(async () => {
  const health = await req('GET', '/api/healthz');
  if (health.status !== 200) throw new Error(`server not healthy at ${DC}: ${health.status}`);

  // account + org
  let r = await req('POST', '/api/auth/setup', { ...ADMIN, orgName: 'Acme Production', setupToken: SETUP });
  if (r.status !== 200) throw new Error(`setup: ${r.status} ${r.body.slice(0, 200)}`);
  const loginRes = await req('POST', '/api/auth/login', { email: ADMIN.email, password: ADMIN.password });
  const cookie = (loginRes.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => c.includes('=') && c.split(/=(.*)/s)[1]).join('; ');
  if (!cookie) throw new Error('login failed: no session cookie');
  const authed = { cookie };

  r = await req('POST', '/api/ui/org/keys', { name: 'demo intake', kind: 'api' }, authed);
  const apiKey = json(r)?.key;
  if (!apiKey) throw new Error(`api key: ${r.status} ${r.body.slice(0, 200)}`);
  const intake = (path, body) => req('POST', path, body, { 'dd-api-key': apiKey });

  // 30 minutes of telemetry
  const now = Date.now();
  let spanCount = 0, logCount = 0, pointCount = 0;
  for (const svc of SERVICES) {
    // metrics: 10s cadence over 30 min with a sine wave + noise
    const pts = [];
    for (let t = now - 30 * 60000; t <= now; t += 10000) {
      pts.push([t, Math.max(1, svc.base * (1 + 0.5 * Math.sin(t / 240000)) + Math.random() * 20)]);
    }
    for (let i = 0; i < pts.length; i += 60) {
      const chunk = pts.slice(i, i + 60);
      const m = await intake('/otlp/v1/metrics', metric(svc, `acme.${svc.name.replace(/-/g, '_')}.requests`, chunk));
      if (m.status >= 300) throw new Error(`metrics intake ${svc.name}: ${m.status} ${m.body.slice(0, 160)}`);
      pointCount += chunk.length;
    }
    // traces + logs: ~2 per 10s slot over the window, ~5% errors
    const traceBodies = [], logBodies = [];
    for (let t = now - 30 * 60000; t <= now; t += 10000) {
      for (let k = 0; k < 2; k++) {
        const route = svc.routes[Math.floor(Math.random() * svc.routes.length)];
        traceBodies.push(trace(svc, route, t + Math.floor(Math.random() * 5000), Math.random() < 0.05));
      }
      if (Math.random() < 0.5) logBodies.push(logs(svc, t, 3));
    }
    for (let i = 0; i < traceBodies.length; i += 25) {
      const batch = traceBodies.slice(i, i + 25);
      const merged = { resourceSpans: batch.flatMap((b) => b.resourceSpans) };
      const tr = await intake('/otlp/v1/traces', merged);
      if (tr.status >= 300) throw new Error(`traces intake ${svc.name}: ${tr.status} ${tr.body.slice(0, 160)}`);
      spanCount += batch.reduce((n, b) => n + b.resourceSpans[0].scopeSpans[0].spans.length, 0);
    }
    for (const lb of logBodies) {
      const lr = await intake('/otlp/v1/logs', lb);
      if (lr.status >= 300) throw new Error(`logs intake ${svc.name}: ${lr.status} ${lr.body.slice(0, 160)}`);
      logCount += lb.resourceLogs[0].scopeLogs[0].logRecords.length;
    }
  }

  // dashboard
  r = await req('POST', '/api/v1/dashboard', {
    title: 'Production overview',
    description: 'M4 demo dashboard: request rates for the three demo services',
    widgets: [
      { definition: { type: 'timeseries', title: 'web-frontend requests', requests: [{ q: 'avg:acme.web_frontend.requests{*}' }] } },
      { definition: { type: 'timeseries', title: 'api-gateway requests', requests: [{ q: 'avg:acme.api_gateway.requests{*}' }] } },
      { definition: { type: 'timeseries', title: 'job-worker requests', requests: [{ q: 'avg:acme.job_worker.requests{*}' }] } },
    ],
  }, authed);
  const dashId = json(r)?.id;
  if (!dashId) throw new Error(`dashboard: ${r.status} ${r.body.slice(0, 200)}`);

  // webhook sink + channel + monitor, then drive the monitor into Alert
  const deliveries = [];
  const sink = http.createServer((rq, rs) => { let b = ''; rq.on('data', (c) => (b += c)); rq.on('end', () => { deliveries.push({ path: rq.url, body: b }); rs.writeHead(200); rs.end('ok'); }); });
  await new Promise((res) => sink.listen(SINK_PORT, '127.0.0.1', res));
  r = await req('POST', '/api/ui/channels', { kind: 'webhook', name: 'demo-alerts', url: `http://127.0.0.1:${SINK_PORT}/hook` }, authed);
  if (r.status !== 200) throw new Error(`channel: ${r.status} ${r.body.slice(0, 200)}`);
  r = await req('POST', '/api/v1/monitor', {
    name: 'High request rate: web-frontend',
    type: 'metric alert',
    query: 'avg(last_1m):avg:acme.web_frontend.requests{*} > 50',
    message: '@webhook-demo-alerts web-frontend request rate is above 50/min',
    options: { thresholds: { critical: 50, critical_recovery: 40 } },
  }, authed);
  const monId = json(r)?.id;
  if (!monId) throw new Error(`monitor: ${r.status} ${r.body.slice(0, 200)}`);

  // metric monitors read closed minute buckets: push points into the current minute,
  // wait for the minute to close, then evaluate.
  const push = async (v, n) => { for (let i = 0; i < n; i++) { await intake('/otlp/v1/metrics', metric(SERVICES[0], 'acme.web_frontend.requests', [[Date.now(), v]])); } };
  const waitNextMinute = async () => { const t = 60000 - (Date.now() % 60000) + 1500; await sleep(t); };
  await push(200, 4);
  await waitNextMinute();
  r = await req('POST', `/api/ui/monitors/${monId}/evaluate`, {}, authed);
  const state = json(r)?.overall_state;
  await sleep(1000);
  const alertDelivered = deliveries.some((d) => d.path === '/hook');
  sink.close();

  // second org so the switcher has real content
  r = await req('POST', '/api/ui/orgs', { name: 'Acme Staging' }, authed);
  const stagingId = json(r)?.id ?? json(r)?.org?.id;
  if (stagingId) {
    await req('POST', '/api/ui/org/select', { orgId: stagingId }, authed);
    r = await req('POST', '/api/ui/org/keys', { name: 'staging intake', kind: 'api' }, authed);
    const stagingKey = json(r)?.key;
    if (stagingKey) {
      const stagingSvc = { name: 'staging-api', hosts: ['staging-1'] };
      await req('POST', '/otlp/v1/logs', logs(stagingSvc, Date.now(), 5), { 'dd-api-key': stagingKey });
      await req('POST', '/otlp/v1/metrics', metric(stagingSvc, 'acme.staging_api.requests', [[Date.now(), 7], [Date.now() - 30000, 5], [Date.now() - 60000, 6]]), { 'dd-api-key': stagingKey });
    }
    // switch back to production for the screenshots
    const orgs = json(await req('GET', '/api/ui/orgs', null, authed));
    const prod = (orgs?.orgs ?? orgs ?? []).find?.((o) => o.name === 'Acme Production');
    if (prod) await req('POST', '/api/ui/org/select', { orgId: prod.id }, authed);
  }

  console.log('DEMO_SUMMARY ' + JSON.stringify({
    url: DC, email: ADMIN.email, dashboardId: dashId, monitorId: monId,
    monitorState: state, alertWebhookDelivered: alertDelivered,
    seeded: { spans: spanCount, logs: logCount, metricPoints: pointCount },
    stagingOrgId: stagingId ?? null,
  }));
  if (state !== 'Alert' || !alertDelivered) { console.error('monitor did not reach Alert with a delivery'); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
