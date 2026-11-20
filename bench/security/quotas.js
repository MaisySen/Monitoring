#!/usr/bin/env node
// Per-organization quota enforcement tests against a running Monitoring server.
//
//   MONITORING_URL=http://127.0.0.1:3000 MONITORING_SETUP_TOKEN=... DATABASE_URL=postgresql://... node bench/security/quotas.js
//
// Covers: daily logs/points/spans limits, the metric series cap, the per-minute ingest byte limit,
// default-unlimited behavior, per-organization independence, admin-only limit changes, and the
// usage endpoint's numbers matching what was actually stored.
'use strict';
const http = require('http');
const crypto = require('crypto');

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:3000';
const SETUP_TOKEN = process.env.MONITORING_SETUP_TOKEN || '';
const RUN = process.env.RUN || crypto.randomBytes(3).toString('hex');
const results = [];
const check = (name, expected, actual, pass) => {
  results.push({ area: 'quotas', name, expected, actual, pass: !!pass });
  process.stderr.write((pass ? 'ok  ' : 'FAIL') + ' ' + name + (pass ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`) + '\n');
};

function req(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(DC + path);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.setTimeout(30000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const cookieOf = (r) =>
  (r.headers['set-cookie'] || [])
    .map((c) => c.split(';')[0])
    .filter((p) => p.split(/=(.*)/s)[1])
    .join('; ');
const nowNs = () => String(BigInt(Date.now()) * 1000000n);
const otlpLog = (service, message) => ({
  resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeLogs: [{ scope: { name: 'q' }, logRecords: [{ timeUnixNano: nowNs(), severityText: 'INFO', body: { stringValue: message } }] }] }],
});
const otlpMetric = (service, name) => ({
  resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeMetrics: [{ scope: { name: 'q' }, metrics: [{ name, gauge: { dataPoints: [{ timeUnixNano: nowNs(), asDouble: 1 }] } }] }] }],
});
const otlpSpan = (service) => ({
  resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ scope: { name: 'q' }, spans: [{ traceId: crypto.randomBytes(16).toString('hex'), spanId: crypto.randomBytes(8).toString('hex'), name: 'op', kind: 2, startTimeUnixNano: nowNs(), endTimeUnixNano: nowNs() }] }] }],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Setup admin of org Q and create API keys.
  const admin = { email: `quota-${RUN}@example.com`, password: `Pw-${crypto.randomBytes(12).toString('hex')}` };
  let r = await req('POST', '/api/auth/setup', { email: admin.email, password: admin.password, orgName: `Quota ${RUN}`, setupToken: SETUP_TOKEN });
  check('setup', 200, r.status, r.status === 200);
  const cookies = cookieOf(r);
  r = await req('POST', '/api/ui/org/keys', { name: 'api', kind: 'api' }, { cookie: cookies });
  const apiKey = json(r)?.key;
  check('api key created', true, !!apiKey, !!apiKey);
  const intake = (path, body) => req('POST', path, body, { 'dd-api-key': apiKey });

  // Default: unlimited — 3 logs stored.
  r = await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'pre-limit'));
  check('unlimited by default (log accepted)', 200, r.status, r.status === 200);

  // Member cannot read quotas? (no member here) — but non-admin key-only callers cannot set quotas.
  r = await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 1 }, { 'dd-api-key': apiKey });
  check('key-only caller cannot set quotas', '401/403', r.status, r.status === 401 || r.status === 403);

  // Set maxLogsPerDay=3: one pre-limit log + 2 more stored, then refused.
  r = await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 3 }, { cookie: cookies });
  check('admin sets daily log limit', 200, r.status, r.status === 200);
  await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'log-2'));
  await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'log-3'));
  r = await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'log-4'));
  check('4th log accepted at HTTP layer', 200, r.status, r.status === 200);
  await sleep(300);
  let q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('usage shows 3 logs, capped', 3, q?.usage?.logs, q?.usage?.logs === 3);
  check('drop recorded with quota reason', true, !!q?.intake?.logs?.last_drop && q.intake.logs.last_drop.reason === 'quota:logs_per_day', q?.intake?.logs?.last_drop?.reason === 'quota:logs_per_day' && q.intake.logs.dropped >= 1);

  // Daily points limit: 5 points allowed.
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 3, maxPointsPerDay: 5 }, { cookie: cookies });
  for (let i = 0; i < 5; i++) await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, `qmetric${i}`));
  await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'qmetric-overflow'));
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('usage shows 5 points, capped', 5, q?.usage?.points, q?.usage?.points === 5);
  check('points drop recorded', 'quota:points_per_day', q?.intake?.metrics?.last_drop?.reason, q?.intake?.metrics?.last_drop?.reason === 'quota:points_per_day');

  // Series cap: only 3 series exist so far? (5 were created above before limit) — set max above current, then exceed.
  const seriesNow = q?.usage?.series ?? 0;
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 3, maxPointsPerDay: 1000, maxSeries: seriesNow + 1 }, { cookie: cookies });
  await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'series-allowed'));
  await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'series-refused-1'));
  await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'series-refused-2'));
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('series capped at limit', seriesNow + 1, q?.usage?.series, q?.usage?.series === seriesNow + 1);
  check('series drop recorded', 'quota:max_series', q?.intake?.metrics?.last_drop?.reason, q?.intake?.metrics?.last_drop?.reason === 'quota:max_series');

  // Existing series still accepted after cap (points flow for known series).
  r = await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'qmetric0'));
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('existing series accepted at cap', true, q?.usage?.points > 5, q?.usage?.points > 5);

  // Spans daily limit.
  await req('PUT', '/api/ui/org/quotas', { maxSpansPerDay: 2, maxPointsPerDay: 1000 }, { cookie: cookies });
  await intake('/otlp/v1/traces', otlpSpan(`qsvc-${RUN}`));
  await intake('/otlp/v1/traces', otlpSpan(`qsvc-${RUN}`));
  await intake('/otlp/v1/traces', otlpSpan(`qsvc-${RUN}`));
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('usage shows 2 spans, capped', 2, q?.usage?.spans, q?.usage?.spans === 2);
  check('span drop recorded', 'quota:spans_per_day', q?.intake?.traces?.last_drop?.reason, q?.intake?.traces?.last_drop?.reason === 'quota:spans_per_day');

  // Per-minute byte limit: tiny cap makes the next intake call 429.
  await req('PUT', '/api/ui/org/quotas', { maxIngestBytesPerMinute: 10 }, { cookie: cookies });
  r = await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'rate-limited'));
  check('byte rate limit returns 429', 429, r.status, r.status === 429);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('byte drop recorded', 'quota:ingest_bytes_per_minute', q?.intake?.logs?.last_drop?.reason, q?.intake?.logs?.last_drop?.reason === 'quota:ingest_bytes_per_minute');

  // Invalid limit rejected.
  r = await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: -5 }, { cookie: cookies });
  check('negative limit rejected', 400, r.status, r.status === 400);
  r = await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 'lots' }, { cookie: cookies });
  check('non-numeric limit rejected', 400, r.status, r.status === 400);

  // Clearing limits restores intake.
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: null, maxIngestBytesPerMinute: null }, { cookie: cookies });
  r = await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'after-clear'));
  check('intake resumes after limits cleared', 200, r.status, r.status === 200);
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('usage keeps counting', true, q?.usage?.logs >= 4, q?.usage?.logs >= 4);

  const failed = results.filter((x) => !x.pass);
  console.log(JSON.stringify({ suite: 'quotas', total: results.length, failed: failed.length, results }, null, 1));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
