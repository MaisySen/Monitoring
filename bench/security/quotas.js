#!/usr/bin/env node
// Per-organization quota enforcement tests against a running Monitoring server.
//
//   MONITORING_URL=http://127.0.0.1:3000 MONITORING_URL2=http://127.0.0.1:3001 MONITORING_SETUP_TOKEN=... node bench/security/quotas.js
//
// Covers: the client-visible refusal contract (429 with reason for daily limits, OTLP partial_success
// for the series cap), default-unlimited behavior, per-organization independence, admin-only limit
// changes, usage numbers matching what was actually stored, and shared enforcement under concurrency:
// with MONITORING_URL2 pointing at a second server process on the same database, parallel batches
// across both processes never exceed a daily limit, the per-minute byte window, or the series cap.
'use strict';
const http = require('http');
const crypto = require('crypto');

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:3000';
const DC2 = process.env.MONITORING_URL2 || null;
const SETUP_TOKEN = process.env.MONITORING_SETUP_TOKEN || '';
const RUN = process.env.RUN || crypto.randomBytes(3).toString('hex');
const results = [];
const check = (name, expected, actual, pass) => {
  results.push({ area: 'quotas', name, expected, actual, pass: !!pass });
  process.stderr.write((pass ? 'ok  ' : 'FAIL') + ' ' + name + (pass ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`) + '\n');
};

function req(method, path, body, headers = {}, base = DC) {
  return new Promise((resolve) => {
    const u = new URL(base + path);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, sentBytes: data ? data.length : 0 }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message), sentBytes: data ? data.length : 0 }));
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
  const intake = (path, body, base) => req('POST', path, body, { 'dd-api-key': apiKey }, base);

  // Default: unlimited — 1 log stored.
  r = await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'pre-limit'));
  check('unlimited by default (log accepted)', 200, r.status, r.status === 200);

  // Key-only callers cannot set quotas.
  r = await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 1 }, { 'dd-api-key': apiKey });
  check('key-only caller cannot set quotas', '401/403', r.status, r.status === 401 || r.status === 403);

  // Daily logs limit 3: pre-limit log + 2 more stored, 4th refused with a client-visible 429.
  r = await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 3 }, { cookie: cookies });
  check('admin sets daily log limit', 200, r.status, r.status === 200);
  await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'log-2'));
  await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'log-3'));
  r = await intake('/otlp/v1/logs', otlpLog(`qsvc-${RUN}`, 'log-4'));
  check('4th log refused with 429', 429, r.status, r.status === 429);
  check('429 body names the reason', true, /limit/i.test(json(r)?.message ?? ''), /limit/i.test(json(r)?.message ?? ''));
  await sleep(300);
  let q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('usage shows 3 logs, capped', 3, q?.usage?.logs, q?.usage?.logs === 3);
  check('drop recorded with quota reason', 'quota:logs_per_day', q?.intake?.logs?.last_drop?.reason, q?.intake?.logs?.last_drop?.reason === 'quota:logs_per_day' && q.intake.logs.dropped >= 1);

  // Daily points limit: 5 stored, 6th batch 429.
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 3, maxPointsPerDay: 5 }, { cookie: cookies });
  for (let i = 0; i < 5; i++) await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, `qmetric${i}`));
  r = await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'qmetric-overflow'));
  check('6th metric batch refused with 429', 429, r.status, r.status === 429);
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('usage shows 5 points, capped', 5, q?.usage?.points, q?.usage?.points === 5);
  check('points drop recorded', 'quota:points_per_day', q?.intake?.metrics?.last_drop?.reason, q?.intake?.metrics?.last_drop?.reason === 'quota:points_per_day');

  // Series cap: allow one more series, then new series are refused but known series keep flowing;
  // the OTLP response carries partial_success with the refused count.
  const seriesNow = q?.usage?.series ?? 0;
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 3, maxPointsPerDay: 1000, maxSeries: seriesNow + 1 }, { cookie: cookies });
  r = await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'series-allowed'));
  check('series under cap accepted, no partial', true, r.status === 200 && !json(r)?.partialSuccess, r.status === 200 && !json(r)?.partialSuccess);
  r = await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'series-refused-1'));
  check('new series refused via partial_success', 1, json(r)?.partialSuccess?.rejectedDataPoints, r.status === 200 && json(r)?.partialSuccess?.rejectedDataPoints >= 1);
  r = await intake('/otlp/v1/metrics', otlpMetric(`qsvc-${RUN}`, 'qmetric0'));
  check('known series accepted at cap, no partial', true, r.status === 200 && !json(r)?.partialSuccess, r.status === 200 && !json(r)?.partialSuccess);
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('series capped at limit', seriesNow + 1, q?.usage?.series, q?.usage?.series === seriesNow + 1);
  check('series drop recorded', 'quota:max_series', q?.intake?.metrics?.last_drop?.reason, q?.intake?.metrics?.last_drop?.reason === 'quota:max_series');

  // Spans daily limit: 2 stored, 3rd refused with 429.
  await req('PUT', '/api/ui/org/quotas', { maxSpansPerDay: 2, maxPointsPerDay: 1000 }, { cookie: cookies });
  await intake('/otlp/v1/traces', otlpSpan(`qsvc-${RUN}`));
  await intake('/otlp/v1/traces', otlpSpan(`qsvc-${RUN}`));
  r = await intake('/otlp/v1/traces', otlpSpan(`qsvc-${RUN}`));
  check('3rd span batch refused with 429', 429, r.status, r.status === 429);
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

  // Invalid limits rejected.
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

  // ---- Shared enforcement under concurrency (second process when MONITORING_URL2 is set) ----
  const bases = DC2 ? [DC, DC2] : [DC];
  // Fresh organization so prior usage does not interfere.
  r = await req('POST', '/api/ui/orgs', { name: `Concurrent ${RUN}` }, { cookie: cookies });
  const orgC = json(r)?.org?.id;
  check('second org created', true, Number.isInteger(orgC), Number.isInteger(orgC));
  await req('POST', '/api/ui/org/select', { orgId: orgC }, { cookie: cookies });
  r = await req('POST', '/api/ui/org/keys', { name: 'api', kind: 'api' }, { cookie: cookies });
  const keyC = json(r)?.key;
  const intakeC = (path, body, base) => req('POST', path, body, { 'dd-api-key': keyC }, base);

  // Daily logs limit 10; 30 concurrent single-log batches across both processes: exactly 10 admitted.
  // Limit changes propagate to the other process within its ~2s quota cache TTL; wait it out.
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 10 }, { cookie: cookies });
  await sleep(2500);
  const logResults = await Promise.all(
    Array.from({ length: 30 }, (_, i) => intakeC('/otlp/v1/logs', otlpLog(`cnc-${RUN}`, `c-${i}`), bases[i % bases.length])),
  );
  const admitted = logResults.filter((x) => x.status === 200).length;
  const refused = logResults.filter((x) => x.status === 429).length;
  check('concurrent daily limit: exactly 10 admitted', 10, admitted, admitted === 10);
  check('concurrent daily limit: rest refused 429', 20, refused, refused === 20);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('concurrent usage exactly at limit', 10, q?.usage?.logs, q?.usage?.logs === 10);

  // Per-minute byte window shared: limit 4000 bytes, 10 concurrent payloads across processes.
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 1000, maxIngestBytesPerMinute: 4000 }, { cookie: cookies });
  await sleep(2500);
  const pad = 'x'.repeat(700);
  const byteResults = await Promise.all(
    Array.from({ length: 10 }, (_, i) => intakeC('/otlp/v1/logs', otlpLog(`cnc-${RUN}`, `b-${i}-${pad}`), bases[i % bases.length])),
  );
  const admittedBytes = byteResults.filter((x) => x.status === 200).reduce((n, x) => n + x.sentBytes, 0);
  check('byte window: admitted bytes within limit', true, admittedBytes <= 4000, admittedBytes <= 4000);
  check('byte window: some refused', true, byteResults.some((x) => x.status === 429), byteResults.some((x) => x.status === 429));
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('byte window counter matches admitted', admittedBytes, q?.usage?.bytesThisMinute, q?.usage?.bytesThisMinute === admittedBytes);

  // Series cap 3 with 12 concurrent brand-new series across processes: final count exactly 3.
  await req('PUT', '/api/ui/org/quotas', { maxLogsPerDay: 1000, maxPointsPerDay: 10000, maxSeries: 3 }, { cookie: cookies });
  await sleep(2500);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => intakeC('/otlp/v1/metrics', otlpMetric(`cnc-${RUN}`, `cseries-${i}`), bases[i % bases.length])),
  );
  await sleep(300);
  q = json(await req('GET', '/api/ui/org/quotas', null, { cookie: cookies }));
  check('concurrent series cap holds exactly', 3, q?.usage?.series, q?.usage?.series === 3);

  const failed = results.filter((x) => !x.pass);
  console.log(JSON.stringify({ suite: 'quotas', total: results.length, failed: failed.length, concurrentProcesses: bases.length, results }, null, 1));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
