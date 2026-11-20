// End-to-end alerting journey against a live server: create a dashboard, create a webhook
// channel, create a metric monitor, drive it into Alert with real intake, verify webhook
// delivery, then drive recovery and verify the recovery delivery. Needs a fresh database
// (first-run setup is one-shot).
//   MONITORING_URL=http://127.0.0.1:3100 MONITORING_SETUP_TOKEN=... node bench/alerting-journey.js
import { randomBytes } from 'node:crypto';
const DC = process.env.MONITORING_URL || 'http://127.0.0.1:3000';
const SETUP = process.env.MONITORING_SETUP_TOKEN;
const RUN = randomBytes(3).toString('hex');
const SINK_PORT = 3100 + 900 + Math.floor(Math.random() * 90);

const results = [];
const check = (name, expected, actual, pass) => results.push({ name, expected, actual, pass: !!pass });

async function req(method, path, body, headers = {}, base = DC) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === null || body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const json = (r) => r.j;
const nowNs = () => String(BigInt(Date.now()) * 1000000n);
const metric = (service, name, value) => ({
  resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeMetrics: [{ scope: { name: 'journey' }, metrics: [{ name, gauge: { dataPoints: [{ timeUnixNano: nowNs(), asDouble: value }] } }] }] }],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Metric queries aggregate into minute buckets and the in-progress bucket is not read back, so a
// point becomes visible to monitor evaluation after the current minute rolls over.
const waitNextMinute = async () => {
  const s = new Date().getSeconds();
  const wait = (62 - s) * 1000;
  process.stderr.write(`waiting ${Math.round(wait / 1000)}s for the minute bucket to close\n`);
  await sleep(wait);
};

// ---- webhook sink ----
const http = await import('node:http');
const deliveries = [];
const sink = http.createServer((rq, rs) => {
  let b = '';
  rq.on('data', (c) => (b += c));
  rq.on('end', () => {
    deliveries.push({ path: rq.url, body: b.slice(0, 500) });
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end('{}');
  });
});
await new Promise((r) => sink.listen(SINK_PORT, '127.0.0.1', r));

async function main() {
  const admin = { email: `journey-${RUN}@example.com`, password: `Pw-${randomBytes(12).toString('hex')}` };
  let r = await req('POST', '/api/auth/setup', { ...admin, orgName: `Journey ${RUN}`, setupToken: SETUP });
  check('setup', 200, r.status, r.status === 200);
  const loginRes = await fetch(DC + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(admin) });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter((c) => c.includes('=') && c.split(/=(.*)/s)[1]).join('; ');
  check('login', true, !!cookies && loginRes.status === 200, !!cookies && loginRes.status === 200);
  process.stderr.write(`login status=${loginRes.status} cookie=${cookies.slice(0, 30)}\n`);
  r = await req('POST', '/api/ui/org/keys', { name: 'api', kind: 'api' }, { cookie: cookies });
  const apiKey = json(r)?.key;
  check('api key created', true, !!apiKey, !!apiKey);
  process.stderr.write(`keys status=${r.status} body=${r.text?.slice(0, 120)}\n`);
  const intake = (body) => req('POST', '/otlp/v1/metrics', body, { 'dd-api-key': apiKey });

  // ---- dashboard ----
  r = await req('POST', '/api/v1/dashboard', {
    title: `Journey ${RUN}`,
    description: 'alerting journey dashboard',
    widgets: [{ definition: { type: 'timeseries', title: 'journey.value', requests: [{ q: 'avg:journey.value{*}' }] } }],
  }, { cookie: cookies });
  const dashId = json(r)?.id;
  check('dashboard created', true, !!dashId, !!dashId);
  r = await req('GET', `/api/v1/dashboard/${dashId}`, null, { cookie: cookies });
  check('dashboard readable with widget', 1, json(r)?.widgets?.length, json(r)?.widgets?.length === 1);

  // ---- webhook channel ----
  r = await req('POST', '/api/ui/channels', { kind: 'webhook', name: `journey-${RUN}`, url: `http://127.0.0.1:${SINK_PORT}/hook` }, { cookie: cookies });
  check('webhook channel created', 200, r.status, r.status === 200);

  // ---- monitor ----
  const query = 'avg(last_1m):avg:journey.value{*} > 50';
  r = await req('POST', '/api/v1/monitor', {
    name: `Journey monitor ${RUN}`,
    type: 'metric alert',
    query,
    message: `@webhook-journey-${RUN} journey.value is high`,
    options: { thresholds: { critical: 50, critical_recovery: 40 } },
  }, { cookie: cookies });
  const monId = json(r)?.id;
  check('monitor created', true, Number.isInteger(monId), Number.isInteger(monId));

  // Below threshold first: expect OK.
  await intake(metric(`journey-${RUN}`, 'journey.value', 10));
  r = await req('POST', `/api/ui/monitors/${monId}/evaluate`, {}, { cookie: cookies });
  check('monitor starts OK below threshold', 'OK', json(r)?.overall_state, json(r)?.overall_state === 'OK');

  // Breach: send high points, evaluate, expect Alert and a webhook delivery.
  for (let i = 0; i < 3; i++) await intake(metric(`journey-${RUN}`, 'journey.value', 100));
  await waitNextMinute();
  r = await req('POST', `/api/ui/monitors/${monId}/evaluate`, {}, { cookie: cookies });
  check('monitor alerts over threshold', 'Alert', json(r)?.overall_state, json(r)?.overall_state === 'Alert');
  await sleep(800);
  const alertHit = deliveries.find((d) => d.path === '/hook');
  check('alert webhook delivered', true, !!alertHit, !!alertHit);
  check('alert payload mentions monitor', true, alertHit?.body?.includes(`Journey monitor ${RUN}`) ?? false, !!alertHit && alertHit.body.includes(`Journey monitor ${RUN}`));

  // Recover: low points under the recovery threshold, evaluate, expect OK and a recovery delivery.
  const before = deliveries.length;
  for (let i = 0; i < 3; i++) await intake(metric(`journey-${RUN}`, 'journey.value', 10));
  await waitNextMinute();
  r = await req('POST', `/api/ui/monitors/${monId}/evaluate`, {}, { cookie: cookies });
  check('monitor recovers', 'OK', json(r)?.overall_state, json(r)?.overall_state === 'OK');
  await sleep(800);
  check('recovery webhook delivered', true, deliveries.length > before, deliveries.length > before);
  const recHit = deliveries[deliveries.length - 1];
  check('recovery payload delivered to same hook', '/hook', recHit?.path, recHit?.path === '/hook');

  const failed = results.filter((x) => !x.pass);
  console.log(JSON.stringify({ suite: 'alerting-journey', total: results.length, failed: failed.length, results }, null, 1));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sink.close());
