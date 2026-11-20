#!/usr/bin/env node
// Data isolation and protection tests against a running Monitoring server (default http://127.0.0.1:8081).
//
//   MONITORING_URL=http://127.0.0.1:3000 DATABASE_URL=postgresql://... node bench/security/isolation.js > isolation-results.json
//
//   1 organization boundaries   two orgs, each with a user and an API key, ingest marked data. Neither can see, look up
//                               by id, change or delete the other's spans, traces, logs, metrics, hosts, monitors,
//                               dashboards, notification channels or keys, through any UI/API route tested
//   2 key revocation            a new key ingests, is revoked, and is refused on the next request (no cache delay)
//   3 malformed payloads        garbage protobuf, invalid JSON, wrong content type, a 60 MB body, a gzip bomb, deep
//                               nesting, huge attribute values and NaN/Infinity metric values are rejected or bounded
//                               with 4xx (never 5xx), the server stays healthy and its memory stays bounded
//   4 redaction                 card numbers, bearer tokens, passwords, AWS keys, JWTs and secret-named attributes sent
//                               in logs and spans are stored as [REDACTED:*]; normal values are untouched
'use strict';
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:3000';
const RUN = process.env.RUN || crypto.randomBytes(3).toString('hex');
const psql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (area, name, expected, actual, pass) => { const r = { area, name, expected, actual, pass: !!pass }; results.push(r); process.stderr.write(JSON.stringify(r) + '\n'); };

function req(method, path, body, headers = {}, raw = false) {
  return new Promise((resolve) => {
    const u = new URL(DC + path);
    const data = body == null ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const h = { ...(data && !raw ? { 'content-type': 'application/json' } : {}), ...(data ? { 'content-length': data.length } : {}), ...headers };
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) })); r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data); r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const cookieOf = (r) => Object.entries(Object.fromEntries((r.headers['set-cookie'] || []).map((c) => c.split(';')[0].split(/=(.*)/s).slice(0, 2)))).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
const newToken = () => crypto.randomBytes(16).toString('hex');
const newKey = () => crypto.randomBytes(16).toString('hex');

async function makeOrg(label) {
  const orgId = Number(psql(`insert into orgs (name) values ('isolation-${label}-${RUN}') returning id`).split('\n')[0]);
  const key = newKey();
  psql(`insert into api_keys (org_id, name, key, kind) values (${orgId}, 'iso ${label}', '${key}', 'api')`);
  const email = `iso-${label}-${RUN}@monitoring.local`, password = `Iso-${crypto.randomBytes(12).toString('hex')}`, token = newToken();
  psql(`insert into invites (org_id, email, role, token) values (${orgId}, '${email}', 'admin', '${token}')`);
  const r = await req('POST', `/api/auth/invites/${token}`, { email, password });
  if (r.status !== 200) throw new Error(`invite accept ${label}: ${r.status} ${r.body}`);
  return { label, orgId, key, cookie: cookieOf(r) };
}

// OTLP JSON payloads with a marker service per org
const nowNs = () => String(BigInt(Date.now()) * 1000000n);
function otlpTrace(service, traceId) {
  return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'host.name', value: { stringValue: `${service}-host` } }] },
    scopeSpans: [{ scope: { name: 'iso' }, spans: [{ traceId, spanId: crypto.randomBytes(8).toString('hex'), name: 'GET /secret', kind: 2, startTimeUnixNano: nowNs(), endTimeUnixNano: nowNs(),
      attributes: [{ key: 'http.route', value: { stringValue: '/secret' } }] }] }] }] };
}
function otlpLog(service, message, attrs = []) {
  return { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeLogs: [{ scope: { name: 'iso' }, logRecords: [{ timeUnixNano: nowNs(), severityText: 'INFO', body: { stringValue: message }, attributes: attrs }] }] }] };
}
const otlpMetric = (service, name) => ({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'host.name', value: { stringValue: `${service}-host` } }] }, scopeMetrics: [{ scope: { name: 'iso' }, metrics: [{ name, gauge: { dataPoints: [{ timeUnixNano: nowNs(), asDouble: 42 }] } }] }] }] });

function otlpErrorTrace(service, traceId) {
  const t = otlpTrace(service, traceId);
  const sp = t.resourceSpans[0].scopeSpans[0].spans[0];
  sp.status = { code: 2 };
  sp.events = [{ name: 'exception', attributes: [
    { key: 'exception.type', value: { stringValue: 'IsoError' } },
    { key: 'exception.message', value: { stringValue: `iso failure for ${service}` } }] }];
  return t;
}

async function ingest(org, service) {
  const traceId = crypto.randomBytes(16).toString('hex');
  const h = { 'DC-API-KEY': org.key };
  const r1 = await req('POST', '/otlp/v1/traces', otlpTrace(service, traceId), h);
  const r2 = await req('POST', '/otlp/v1/logs', otlpLog(service, `marker log for ${service}`), h);
  const r3 = await req('POST', '/otlp/v1/metrics', otlpMetric(service, `iso.${service.replace(/-/g, '_')}.value`), h);
  return { traceId, statuses: [r1.status, r2.status, r3.status] };
}

(async () => {
  const health0 = await req('GET', '/api/healthz');
  if (health0.status !== 200) throw new Error(`server not healthy at ${DC}`);
  // ---------------- 1 organization boundaries ----------------
  const A = await makeOrg('a'), B = await makeOrg('b');
  const svcA = `iso-a-${RUN}`, svcB = `iso-b-${RUN}`;
  const ia = await ingest(A, svcA), ib = await ingest(B, svcB);
  check('isolation', 'both orgs can ingest with their own key', '2xx', `${ia.statuses} / ${ib.statuses}`, [...ia.statuses, ...ib.statuses].every((s) => s >= 200 && s < 300));
  // resources owned by A
  const monA = json(await req('POST', '/api/v1/monitor', { name: `iso monitor ${RUN}`, type: 'metric alert', query: `avg(last_5m):avg:iso.${svcA.replace(/-/g, '_')}.value{*} > 100`, message: 'x', options: { thresholds: { critical: 100 } } }, { cookie: A.cookie }));
  const dashA = json(await req('POST', '/api/v1/dashboard', { title: `iso dashboard ${RUN}`, layout_type: 'ordered', widgets: [] }, { cookie: A.cookie }));
  const chA = json(await req('POST', '/api/ui/channels', { kind: 'webhook', name: `iso-${RUN}`, url: 'http://127.0.0.1:5400/iso' }, { cookie: A.cookie }));
  await sleep(4000); // rollups / batching
  const now = Math.floor(Date.now() / 1000), q = `from=${now - 600}&to=${now + 60}`;
  const as = (org) => ({ cookie: org.cookie });
  const sees = async (org, other, otherSvc, otherTrace) => {
    const leaks = [];
    const svcs = json(await req('GET', `/api/ui/apm/services?${q}`, null, as(org)));
    if ((svcs?.services || []).some((s) => s.service === otherSvc)) leaks.push('apm services list');
    const page = json(await req('GET', `/api/ui/apm/services/${otherSvc}?${q}`, null, as(org)));
    if ((page?.resources || []).length || (page?.timeseries || []).some((t) => t.hits)) leaks.push('apm service page');
    const spans = json(await req('POST', `/api/ui/apm/spans?${q}`, { query: `service:${otherSvc}` }, as(org)));
    if ((spans?.spans || []).length) leaks.push('span search');
    const allSpans = json(await req('POST', `/api/ui/apm/spans?${q}`, { query: '*', limit: 1000 }, as(org)));
    if ((allSpans?.spans || []).some((s) => s.service === otherSvc)) leaks.push('span search *');
    const tr = json(await req('GET', `/api/ui/apm/traces/${otherTrace}`, null, as(org)));
    if ((tr?.spans || []).length || (tr?.logs || []).length) leaks.push('trace by id');
    const logs = json(await req('POST', `/api/ui/logs/search?${q}`, { query: `service:${otherSvc}` }, as(org)));
    if ((logs?.logs || []).length) leaks.push('log search');
    const logsAll = json(await req('POST', `/api/ui/logs/search?${q}`, { query: 'marker log', limit: 1000 }, as(org)));
    if ((logsAll?.logs || []).some((l) => l.service === otherSvc)) leaks.push('log full-text search');
    const facets = json(await req('POST', `/api/ui/logs/facets?${q}`, { query: '*' }, as(org)));
    if (JSON.stringify(facets || {}).includes(otherSvc)) leaks.push('log facets');
    const metrics = json(await req('GET', `/api/ui/metrics?${q}`, null, as(org)));
    if (JSON.stringify(metrics || {}).includes(otherSvc.replace(/-/g, '_'))) leaks.push('metric names');
    const mq = json(await req('POST', `/api/ui/metrics/query?${q}`, { queries: [{ name: 'a', query: `avg:iso.${otherSvc.replace(/-/g, '_')}.value{*}` }] }, as(org)));
    if ((mq?.series || []).some((s) => s.pointlist?.length)) leaks.push('metric query');
    const hosts = json(await req('GET', `/api/ui/hosts?${q}`, null, as(org)));
    if (JSON.stringify(hosts || {}).includes(`${otherSvc}-host`)) leaks.push('host list');
    const mons = json(await req('GET', '/api/v1/monitor', null, as(org)));
    if (JSON.stringify(mons || {}).includes(`iso monitor ${RUN}`) && org !== A) leaks.push('monitor list');
    const dashes = json(await req('GET', '/api/v1/dashboard', null, as(org)));
    if (JSON.stringify(dashes || {}).includes(`iso dashboard ${RUN}`) && org !== A) leaks.push('dashboard list');
    const chans = json(await req('GET', '/api/ui/channels', null, as(org)));
    if (JSON.stringify(chans || {}).includes(`iso-${RUN}`) && org !== A) leaks.push('channel list');
    const orgInfo = json(await req('GET', '/api/ui/org', null, as(org)));
    if (JSON.stringify(orgInfo || {}).includes(other.key)) leaks.push('org keys');
    return leaks;
  };
  const leaksB = await sees(B, A, svcA, ia.traceId);
  check('isolation', "org B sees none of org A's data (15 read surfaces)", 'no leaks', leaksB.join(', ') || 'no leaks', leaksB.length === 0);
  const leaksA = await sees(A, B, svcB, ib.traceId);
  check('isolation', "org A sees none of org B's data (15 read surfaces)", 'no leaks', leaksA.join(', ') || 'no leaks', leaksA.length === 0);
  // sanity: each org sees its own
  const ownA = json(await req('POST', `/api/ui/apm/spans?${q}`, { query: `service:${svcA}` }, as(A)));
  check('isolation', 'org A sees its own spans (sanity)', '>=1', (ownA?.spans || []).length, (ownA?.spans || []).length >= 1);
  // direct object access by id across orgs
  // error groups: intake-derived rows must obey the same org boundary
  const errTrace = crypto.randomBytes(16).toString('hex');
  const er = await req('POST', '/otlp/v1/traces', otlpErrorTrace(svcA, errTrace), { 'DC-API-KEY': A.key });
  await sleep(4000);
  const groupsA = json(await req('GET', `/api/ui/errors?service=${svcA}`, null, as(A)));
  const fpA = groupsA?.groups?.[0]?.fingerprint;
  check('isolation', 'org A sees its own error group (sanity)', '>=1 group with fingerprint', `${groupsA?.groups?.length ?? 0} groups`, (groupsA?.groups || []).length >= 1 && !!fpA);
  const groupsB = json(await req('GET', `/api/ui/errors?service=${svcA}`, null, as(B)));
  check('isolation', "org B error-groups list hides org A's groups", '0 groups', `${groupsB?.groups?.length ?? 'n/a'} groups`, (groupsB?.groups || []).length === 0);
  const detailB = await req('GET', `/api/ui/errors/${fpA}/spans`, null, as(B));
  check('isolation', "org B cannot read org A's error-group detail", '404', `${detailB.status}`, detailB.status === 404);
  // problem workflow status must obey the same org boundary: B cannot set or clear a status on
  // A's error group or monitor, no row is written for B, and A's own status stays scoped to A.
  const psLeak = [];
  const ps1 = await req('POST', '/api/ui/problems/status', { kind: 'error_group', ref: fpA, status: 'resolved' }, as(B));
  if (ps1.status !== 404) psLeak.push(`error_group status -> ${ps1.status}`);
  const ps2 = await req('POST', '/api/ui/problems/status', { kind: 'monitor', ref: String(monA.id), status: 'muted' }, as(B));
  if (ps2.status !== 404) psLeak.push(`monitor status -> ${ps2.status}`);
  await req('POST', '/api/ui/problems/status', { kind: 'error_group', ref: fpA, status: 'resolved' }, as(A));
  if (psql(`select count(*) from problem_status where org_id=${A.orgId} and kind='error_group' and ref='${fpA}'`) !== '1') psLeak.push("A's own status not stored");
  const psRowsB = psql(`select count(*) from problem_status where org_id=${B.orgId}`);
  if (psRowsB !== '0') psLeak.push(`${psRowsB} row(s) written for B`);
  await req('POST', '/api/ui/problems/status', { kind: 'error_group', ref: fpA, status: 'open' }, as(A));
  check('isolation', "problem status: B cannot write against A's monitor/error group; writes stay org-scoped", 'refused + scoped', psLeak.join('; ') || 'refused + scoped', psLeak.length === 0);
  const byId = [];
  const m1 = await req('GET', `/api/v1/monitor/${monA.id}`, null, as(B)); if (m1.status === 200) byId.push(`GET monitor ${m1.status}`);
  const m2 = await req('PUT', `/api/v1/monitor/${monA.id}`, { name: 'hijacked', type: 'metric alert', query: monA.query }, as(B)); if (m2.status === 200 && json(await req('GET', `/api/v1/monitor/${monA.id}`, null, as(A)))?.name === 'hijacked') byId.push('PUT monitor changed it');
  const m3 = await req('DELETE', `/api/v1/monitor/${monA.id}`, null, as(B)); if ((await req('GET', `/api/v1/monitor/${monA.id}`, null, as(A))).status !== 200) byId.push(`DELETE monitor removed it (${m3.status})`);
  const d1 = await req('GET', `/api/v1/dashboard/${dashA.id}`, null, as(B)); if (d1.status === 200 && json(d1)?.title) byId.push(`GET dashboard ${d1.status}`);
  const d2 = await req('DELETE', `/api/v1/dashboard/${dashA.id}`, null, as(B)); if ((await req('GET', `/api/v1/dashboard/${dashA.id}`, null, as(A))).status !== 200) byId.push(`DELETE dashboard removed it (${d2.status})`);
  if (chA?.id) { await req('DELETE', `/api/ui/channels/${chA.id}`, null, as(B)); if (!(json(await req('GET', '/api/ui/channels', null, as(A)))?.channels || []).some((c) => c.id === chA.id)) byId.push('DELETE channel removed it'); }
  const keyAId = psql(`select id from api_keys where key='${A.key}'`);
  await req('DELETE', `/api/ui/org/keys/${keyAId}`, null, as(B));
  if ((await req('POST', '/otlp/v1/logs', otlpLog(svcA, 'still works'), { 'DC-API-KEY': A.key })).status >= 400) byId.push("B revoked A's key");
  check('isolation', "cross-org access by id (monitor GET/PUT/DELETE, dashboard GET/DELETE, channel DELETE, key revoke)", 'all refused, nothing changed', byId.join('; ') || 'all refused, nothing changed', byId.length === 0);
  // a key can only write into its own org (no org override via headers/body)
  await req('POST', '/otlp/v1/logs', otlpLog(`iso-override-${RUN}`, 'override attempt'), { 'DC-API-KEY': B.key, 'x-monitoring-org': String(A.orgId), 'dd-org-id': String(A.orgId) });
  await sleep(1500);
  const landed = psql(`select string_agg(distinct org_id::text, ',') from logs where service='iso-override-${RUN}'`);
  check('isolation', "org override headers ignored: B's key writes only into B", String(B.orgId), landed, landed === String(B.orgId));
  check('isolation', 'unauthenticated UI/API requests refused', '401', `${(await req('GET', `/api/ui/apm/services?${q}`)).status}/${(await req('POST', '/otlp/v1/logs', otlpLog('x', 'y'))).status}`,
    (await req('GET', `/api/ui/apm/services?${q}`)).status === 401 && [401, 403].includes((await req('POST', '/otlp/v1/logs', otlpLog('x', 'y'))).status));

  // ---------------- 2 key revocation ----------------
  const created = json(await req('POST', '/api/ui/org/keys', { name: `revoke-test-${RUN}` }, as(A)));
  const before = (await req('POST', '/otlp/v1/logs', otlpLog(svcA, 'before revoke'), { 'DC-API-KEY': created.key })).status;
  await req('DELETE', `/api/ui/org/keys/${created.id}`, null, as(A));
  const t = Date.now();
  const after = (await req('POST', '/otlp/v1/logs', otlpLog(svcA, 'after revoke'), { 'DC-API-KEY': created.key })).status;
  const afterDd = (await req('POST', '/api/v2/logs', [{ message: 'after revoke dd', service: svcA }], { 'DD-API-KEY': created.key })).status;
  check('revocation', 'new key accepted, then refused right after revocation (OTLP and Agent intake)', '2xx then 403/401', `${before} then ${after}/${afterDd} after ${Date.now() - t} ms`,
    before >= 200 && before < 300 && [401, 403].includes(after) && [401, 403].includes(afterDd));

  // ---------------- 3 malformed payloads ----------------
  // the server process to watch: DC_PID, or the newest process matching DC_PROC (default: the API bundle)
  const pid = Number(process.env.DC_PID || execSync(`pgrep -n -f '${process.env.DC_PROC || 'api-server/dist[^/]*/index.mjs|[.]/dist[^/]*/index.mjs'}' || true`, { encoding: 'utf8' }).trim());
  const rss = () => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024; } catch { return null; } };
  const rss0 = rss();
  const K = { 'DC-API-KEY': B.key };
  const cases = [
    ['garbage protobuf', '/otlp/v1/traces', crypto.randomBytes(4096), { 'content-type': 'application/x-protobuf' }],
    ['truncated protobuf', '/otlp/v1/traces', Buffer.from([0x0a, 0xff, 0xff, 0xff, 0x0f, 0x01]), { 'content-type': 'application/x-protobuf' }],
    ['invalid JSON', '/otlp/v1/logs', Buffer.from('{"resourceLogs": [ {'), { 'content-type': 'application/json' }],
    ['wrong content type', '/otlp/v1/logs', Buffer.from('hello'), { 'content-type': 'text/plain' }],
    ['60 MB body', '/otlp/v1/logs', Buffer.alloc(60 << 20, 0x20), { 'content-type': 'application/json' }],
    ['gzip bomb (100 KB -> 1 GB)', '/otlp/v1/logs', zlib.gzipSync(Buffer.alloc(1 << 30, 0x20), { level: 9 }), { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
    ['deeply nested JSON (100k levels)', '/otlp/v1/logs', Buffer.from('['.repeat(100000) + ']'.repeat(100000)), { 'content-type': 'application/json' }],
    ['10 MB attribute value', '/otlp/v1/logs', Buffer.from(JSON.stringify(otlpLog(`iso-big-${RUN}`, 'big', [{ key: 'blob', value: { stringValue: 'x'.repeat(10 << 20) } }]))), { 'content-type': 'application/json' }],
    ['NaN/Infinity metric values', '/api/v1/series', Buffer.from('{"series":[{"metric":"iso.nan","points":[[' + Math.floor(Date.now() / 1000) + ',"NaN"],[' + Math.floor(Date.now() / 1000) + ',1e999]]}]}'), { 'content-type': 'application/json', 'DD-API-KEY': B.key }],
    ['negative / far-future timestamps', '/otlp/v1/logs', Buffer.from(JSON.stringify({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: '-5', body: { stringValue: 'neg' } }, { timeUnixNano: '99999999999999999999', body: { stringValue: 'future' } }] }] }] })), { 'content-type': 'application/json' }],
  ];
  const mal = [];
  for (const [name, path, body, headers] of cases) {
    const r = await req('POST', path, body, { ...K, ...headers }, true);
    const healthy = (await req('GET', '/api/healthz')).status === 200;
    mal.push({ name, status: r.status, healthy, ...(r.status === 0 ? { error: r.body } : {}) });
  }
  const rss1 = rss();
  const bad = mal.filter((m) => m.status >= 500 || m.status === 0 || !m.healthy);
  check('malformed', 'malformed payloads get 4xx (or bounded 2xx), never 5xx; server healthy after each', 'no 5xx, healthy', mal.map((m) => `${m.name}: ${m.status}`).join('; '), bad.length === 0);
  check('malformed', 'server memory bounded after the malformed payloads (incl. 60 MB body and gzip bomb)', '< +300 MB', `${Math.round(rss0)} -> ${Math.round(rss1)} MB`, rss1 != null && rss1 - rss0 < 300);
  const big = psql(`select coalesce(max(length(attributes->>'blob')),0) from logs where service='iso-big-${RUN}'`);
  check('malformed', '10 MB attribute is truncated or rejected, not stored whole', '< 10 MB stored', `${big} chars stored`, Number(big) < (10 << 20));

  // ---------------- 4 redaction ----------------
  const svcR = `iso-redact-${RUN}`;
  const secrets = {
    card: '4111 1111 1111 1111', bearer: 'Bearer eyJhbGciOi.abcdefghijk.lmnopqrstuv', awskey: 'AKIAIOSFODNN7EXAMPLE',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', pass: 'password=hunter2hunter2',
  };
  const msg = `charge card ${secrets.card} with header ${secrets.bearer} using ${secrets.awskey} token ${secrets.jwt} and ${secrets.pass}; order 1234 for 3 items`;
  await req('POST', '/otlp/v1/logs', otlpLog(svcR, msg, [{ key: 'user.password', value: { stringValue: 'p@ss-word-123' } }, { key: 'http.request.header.authorization', value: { stringValue: secrets.bearer } }, { key: 'order.id', value: { stringValue: 'ord-555' } }]), K);
  const tr = otlpTrace(svcR, crypto.randomBytes(16).toString('hex'));
  tr.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({ key: 'db.statement', value: { stringValue: `select * from users where card='${secrets.card}'` } }, { key: 'http.url', value: { stringValue: `https://shop.example.com/pay?api_key=sk_live_abcdef123456&amount=10` } });
  await req('POST', '/otlp/v1/traces', tr, K);
  await sleep(2500);
  const stored = psql(`select message || ' ' || attributes::text from logs where service='${svcR}' limit 1`) + ' ' + psql(`select meta::text from spans where service='${svcR}' limit 1`);
  const leaked = Object.entries({ ...secrets, attr_password: 'p@ss-word-123', url_api_key: 'sk_live_abcdef123456' }).filter(([, v]) => stored.includes(v.split(' ').pop()) || stored.includes(v)).map(([k]) => k);
  check('redaction', 'secrets in log message, log attributes and span attributes are masked before storage', 'none stored', leaked.join(', ') || 'none stored', leaked.length === 0 && stored.includes('[REDACTED:'));
  check('redaction', 'ordinary values are untouched', 'order 1234 / ord-555 / amount=10 kept', ['order 1234', 'ord-555', 'amount=10'].filter((v) => !stored.includes(v)).join(', ') || 'kept', ['order 1234', 'ord-555', 'amount=10'].every((v) => stored.includes(v)));

  const passed = results.filter((r) => r.pass).length;
  console.log(JSON.stringify({ run: RUN, server: DC, passed, total: results.length, results, malformed: mal }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
