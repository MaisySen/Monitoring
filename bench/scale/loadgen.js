'use strict';
// Monitoring large-scale load generator.
// Simulates HOSTS hosts running SERVICES services that emit distributed traces (OTLP protobuf),
// correlated logs and metrics (OTLP JSON), including host metrics for every host and a
// high-cardinality custom metric. Every record carries loadtest.run=<RUN> so the stored counts can
// be checked against what was sent (no data loss).
//
// env: TARGET (default http://127.0.0.1:3000/otlp/v1) — or http://127.0.0.1:4318/v1 to go through the agent
//      MONITORING_API_KEY, RUN, HOSTS=200, SERVICES=50, TRACES_PER_S=400, SECONDS=600, CARDINALITY=20000, CONCURRENCY=8
const http = require('node:http');
const crypto = require('node:crypto');
const { Writer } = require('../../sdks/node/lib/span-exporter.js');

const TARGET = process.env.TARGET || 'http://127.0.0.1:3000/otlp/v1';
const KEY = process.env.MONITORING_API_KEY || '';
const RUN = process.env.RUN || `run-${Date.now()}`;
const HOSTS = Number(process.env.HOSTS || 200);
const SERVICES = Number(process.env.SERVICES || 50);
const TPS = Number(process.env.TRACES_PER_S || 400);
const SECONDS = Number(process.env.SECONDS || 600);
const CARD = Number(process.env.CARDINALITY || 20000);
const CONC = Number(process.env.CONCURRENCY || 8);
const agent = new http.Agent({ keepAlive: true, maxSockets: CONC * 3 });

const stats = { spans: 0, logs: 0, points: 0, requests: 0, errors: 0, latencies: [], startedAt: Date.now() };
const services = Array.from({ length: SERVICES }, (_, i) => ({ name: `svc-${String(i).padStart(2, '0')}`, lang: i % 3 === 0 ? 'python' : 'nodejs', db: i % 4 === 0 ? 'postgresql' : i % 4 === 1 ? 'redis' : null }));
const hosts = Array.from({ length: HOSTS }, (_, i) => `scale-host-${String(i).padStart(3, '0')}`);
const routes = ['GET /api/items', 'GET /api/items/:id', 'POST /api/orders', 'GET /api/users/:id', 'PUT /api/cart', 'GET /health', 'POST /api/search', 'DELETE /api/cart/:id'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const hex = (n) => crypto.randomBytes(n).toString('hex');
const nowNs = () => BigInt(Date.now()) * 1000000n;

function post(path, body, type) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const headers = { 'content-type': type, 'content-length': body.length };
    if (KEY) headers['DC-API-KEY'] = KEY;
    const req = http.request(`${TARGET}/${path}`, { method: 'POST', agent, headers, timeout: 30000 }, (res) => {
      res.resume();
      res.on('end', () => {
        stats.requests++;
        stats.latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
        if (res.statusCode >= 300) { stats.errors++; if (stats.errors < 5) console.error(`HTTP ${res.statusCode} on ${path}`); }
        resolve(res.statusCode < 300);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { stats.errors++; if (stats.errors < 5) console.error(e.message); resolve(false); });
    req.end(body);
  });
}

// ---- traces (protobuf, hand-encoded with Monitoring's writer)
function kv(w, field, k, v) { const at = w.begin(field); w.string(1, k); const av = w.begin(2); if (typeof v === 'number') { w.tag(3, 0); w.varint(v); } else w.string(1, String(v)); w.end(av); w.end(at); }
function hr(ns) { return [Number(ns / 1000000000n), Number(ns % 1000000000n)]; }
function makeTrace(endNs) {
  const traceId = hex(16); const svc = pick(services); const route = pick(routes); const host = pick(hosts);
  const total = 5 + Math.floor(Math.random() * 120); const error = Math.random() < 0.02;
  const spans = []; const root = hex(8); const start = endNs - BigInt(total) * 1000000n;
  spans.push({ svc, host, id: root, parent: null, name: route.split(' ')[0], kind: 2, start, end: endNs, attrs: { 'http.request.method': route.split(' ')[0], 'http.route': route.split(' ')[1], 'http.response.status_code': error ? 500 : 200, 'customer.tier': pick(['free', 'pro', 'enterprise']) }, error });
  let t = start + 1000000n;
  const hops = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < hops; i++) {
    const down = pick(services); const id = hex(8); const dur = BigInt(1 + Math.floor(Math.random() * total / (hops + 1))) * 1000000n;
    spans.push({ svc, host, id: hex(8), parent: root, name: 'GET', kind: 3, start: t, end: t + dur, attrs: { 'http.request.method': 'GET', 'server.address': down.name, 'http.response.status_code': 200 } });
    spans.push({ svc: down, host: pick(hosts), id, parent: spans[spans.length - 1].id, name: 'GET', kind: 2, start: t + 100000n, end: t + dur - 100000n, attrs: { 'http.request.method': 'GET', 'http.route': '/internal/' + pick(['price', 'stock', 'auth', 'profile']), 'http.response.status_code': 200 } });
    if (down.db) spans.push({ svc: down, host: spans[spans.length - 1].host, id: hex(8), parent: id, name: down.db === 'redis' ? 'GET' : 'SELECT', kind: 3, start: t + 200000n, end: t + dur / 2n, attrs: { 'db.system': down.db, 'db.statement': down.db === 'redis' ? 'GET cart:*' : 'SELECT * FROM items WHERE id = $1' } });
    t += dur;
  }
  return { traceId, spans, error, svc, host, root };
}
function encodeTraces(traces) {
  const w = new Writer(1 << 20);
  const groups = new Map();
  for (const tr of traces) for (const s of tr.spans) {
    const key = s.svc.name + '|' + s.host;
    if (!groups.has(key)) groups.set(key, { svc: s.svc, host: s.host, list: [] });
    groups.get(key).list.push({ tr, s });
  }
  for (const g of groups.values()) {
    const rs = w.begin(1);
    const res = w.begin(1);
    kv(w, 1, 'service.name', g.svc.name); kv(w, 1, 'host.name', g.host); kv(w, 1, 'deployment.environment.name', 'scale');
    kv(w, 1, 'telemetry.sdk.language', g.svc.lang); kv(w, 1, 'service.version', '2.4.1'); kv(w, 1, 'loadtest.run', RUN);
    w.end(res);
    const ss = w.begin(2);
    const sc = w.begin(1); w.string(1, 'loadgen'); w.end(sc);
    for (const { tr, s } of g.list) {
      const sp = w.begin(2);
      w.hexBytes(1, tr.traceId, 16); w.hexBytes(2, s.id, 8); if (s.parent) w.hexBytes(4, s.parent, 8);
      w.string(5, s.name); w.tag(6, 0); w.byte(s.kind);
      w.fixed64HrTime(7, hr(s.start)); w.fixed64HrTime(8, hr(s.end));
      for (const [k, v] of Object.entries(s.attrs)) kv(w, 9, k, v);
      if (s.error) { const st = w.begin(15); w.string(2, 'upstream failed'); w.tag(3, 0); w.byte(2); w.end(st); }
      w.end(sp);
      stats.spans++;
    }
    w.end(ss); w.end(rs);
  }
  return Buffer.from(w.buf.subarray(0, w.pos));
}

// ---- logs (OTLP JSON), one or two per trace, linked to the root span
function encodeLogs(traces) {
  const byRes = new Map();
  for (const tr of traces) {
    const key = tr.svc.name + '|' + tr.host;
    if (!byRes.has(key)) byRes.set(key, { svc: tr.svc, host: tr.host, records: [] });
    const n = tr.error ? 2 : 1;
    for (let i = 0; i < n; i++) {
      byRes.get(key).records.push({ timeUnixNano: String(tr.spans[0].end), severityText: tr.error ? 'ERROR' : 'INFO', severityNumber: tr.error ? 17 : 9,
        body: { stringValue: tr.error ? `request failed for order ${Math.floor(Math.random() * 1e6)}: upstream failed` : `handled ${tr.spans[0].attrs['http.route']} in ${Number((tr.spans[0].end - tr.spans[0].start) / 1000000n)}ms` },
        traceId: tr.traceId, spanId: tr.root, attributes: [{ key: 'customer.id', value: { stringValue: `cust-${Math.floor(Math.random() * CARD)}` } }] });
      stats.logs++;
    }
  }
  const resourceLogs = [...byRes.values()].map((g) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: g.svc.name } }, { key: 'host.name', value: { stringValue: g.host } }, { key: 'deployment.environment.name', value: { stringValue: 'scale' } }, { key: 'loadtest.run', value: { stringValue: RUN } }] }, scopeLogs: [{ scope: { name: 'loadgen' }, logRecords: g.records }] }));
  return Buffer.from(JSON.stringify({ resourceLogs }));
}

// ---- metrics (OTLP JSON): host metrics for every host every 15 s, plus a high-cardinality counter
function hostMetrics(hostList) {
  const t = String(nowNs());
  const gauge = (name, v, attrs = []) => ({ name, gauge: { dataPoints: [{ timeUnixNano: t, asDouble: v, attributes: attrs }] } });
  const resourceMetrics = hostList.map((h, i) => {
    const load = 0.5 + (i % 10) / 4 + Math.random() * 0.3;
    const ms = [
      gauge('system.cpu.utilization', 0.1 + (i % 7) / 10 + Math.random() * 0.05, [{ key: 'state', value: { stringValue: 'user' } }]),
      gauge('system.cpu.utilization', 0.05 + Math.random() * 0.03, [{ key: 'state', value: { stringValue: 'system' } }]),
      gauge('system.cpu.load_average.1m', load), gauge('system.cpu.load_average.5m', load * 0.9), gauge('system.cpu.load_average.15m', load * 0.8),
      gauge('system.memory.usage', 2e9 + (i % 16) * 5e8, [{ key: 'state', value: { stringValue: 'used' } }]),
      gauge('system.memory.usage', 6e9, [{ key: 'state', value: { stringValue: 'free' } }]),
      gauge('system.filesystem.utilization', 0.3 + (i % 5) / 10, [{ key: 'mountpoint', value: { stringValue: '/' } }]),
    ];
    stats.points += ms.length;
    return { resource: { attributes: [{ key: 'host.name', value: { stringValue: h } }, { key: 'os.type', value: { stringValue: 'linux' } }, { key: 'loadtest.run', value: { stringValue: RUN } }] }, scopeMetrics: [{ scope: { name: 'otelcol/hostmetricsreceiver' }, metrics: ms }] };
  });
  return Buffer.from(JSON.stringify({ resourceMetrics }));
}
function customMetrics(n) {
  const t = String(nowNs()); const start = String(nowNs() - 10000000000n);
  const dataPoints = Array.from({ length: n }, () => ({ startTimeUnixNano: start, timeUnixNano: t, asInt: String(1 + Math.floor(Math.random() * 5)), attributes: [{ key: 'customer.id', value: { stringValue: `cust-${Math.floor(Math.random() * CARD)}` } }, { key: 'plan', value: { stringValue: pick(['free', 'pro', 'enterprise']) } }] }));
  stats.points += n;
  return Buffer.from(JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-00' } }, { key: 'loadtest.run', value: { stringValue: RUN } }] }, scopeMetrics: [{ scope: { name: 'loadgen' }, metrics: [{ name: 'scale.orders.placed', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints } }] }] }] }));
}

(async () => {
  const end = Date.now() + SECONDS * 1000;
  const inflight = new Set();
  const send = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); };
  let lastHost = 0; let lastCustom = 0; let tick = 0;
  console.error(JSON.stringify({ run: RUN, target: TARGET, hosts: HOSTS, services: SERVICES, traces_per_s: TPS, seconds: SECONDS, cardinality: CARD }));
  while (Date.now() < end) {
    const t0 = Date.now();
    // 4 batches per second
    const traces = Array.from({ length: Math.round(TPS / 4) }, () => makeTrace(nowNs()));
    while (inflight.size >= CONC) await Promise.race(inflight);
    send(post('traces', encodeTraces(traces), 'application/x-protobuf'));
    send(post('logs', encodeLogs(traces), 'application/json'));
    if (t0 - lastHost >= 15000) { lastHost = t0; for (let i = 0; i < hosts.length; i += 50) send(post('metrics', hostMetrics(hosts.slice(i, i + 50)), 'application/json')); }
    if (t0 - lastCustom >= 10000) { lastCustom = t0; send(post('metrics', customMetrics(Math.min(CARD, 2000)), 'application/json')); }
    if (++tick % 40 === 0) {
      const l = [...stats.latencies].sort((a, b) => a - b);
      console.error(JSON.stringify({ t: Math.round((Date.now() - stats.startedAt) / 1000), spans: stats.spans, logs: stats.logs, points: stats.points, errors: stats.errors, intake_p50_ms: Math.round(l[Math.floor(l.length * 0.5)] || 0), intake_p99_ms: Math.round(l[Math.floor(l.length * 0.99)] || 0), inflight: inflight.size }));
      stats.latencies = [];
    }
    const wait = 250 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await Promise.allSettled([...inflight]);
  const secs = (Date.now() - stats.startedAt) / 1000;
  const out = { run: RUN, seconds: Math.round(secs), sent: { spans: stats.spans, logs: stats.logs, metric_points: stats.points }, rate: { spans_per_s: Math.round(stats.spans / secs), logs_per_s: Math.round(stats.logs / secs) }, requests: stats.requests, errors: stats.errors };
  console.log(JSON.stringify(out));
  require('node:fs').writeFileSync(require('node:path').join(__dirname, `sent-${RUN}.json`), JSON.stringify(out));
})();
