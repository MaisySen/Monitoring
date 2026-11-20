#!/usr/bin/env node
// B1 Multies bridge tests (docs/MULTIES-BRIDGE.md) against two running Monitoring servers and a stub
// Multies v1 API (started by this script on 127.0.0.1:5800).
//
//   MONITORING_URL=http://127.0.0.1:4800      server with MONITORING_ALLOW_PRIVATE_WEBHOOKS=true
//   MONITORING_URL_BLOCK=http://127.0.0.1:4801 server without it
//   MONITORING_SETUP_TOKEN=... DATABASE_URL=... node bench/security/multies-bridge.js
//
// Covers: bind success against the stub (and what is stored), key rejected by Multies, key format
// refusal before any network call, admin-only write, member read, re-bind replacement, unbind, the raw
// key never reaching the database, and private/local destinations refused when not explicitly allowed.
'use strict';
const http = require('http');
const crypto = require('crypto');

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:4800';
const DCB = process.env.MONITORING_URL_BLOCK || '';
const SETUP_TOKEN = process.env.MONITORING_SETUP_TOKEN || '';
const results = [];
const check = (name, expected, actual, pass) => {
  results.push({ area: 'multies-bridge', name, expected, actual, pass: !!pass });
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.setTimeout(30000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
// Login sends a clearing cookie before the new one; the last value for a name wins.
const cookies = (r) => {
  const m = new Map();
  for (const c of r.headers['set-cookie'] || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    m.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...m].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
};
async function login(base, email, password) {
  const r = await req('POST', '/api/auth/login', { email, password }, {}, base);
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  return cookies(r);
}

// ---- stub Multies v1 API: honors exactly one workspace key -------------------------------
const VALID_KEY = 'mm_live_test_' + crypto.randomBytes(12).toString('hex');
let stubHits = 0;
const stub = http.createServer((req, res) => {
  if (req.url === '/api/v1/domains') {
    stubHits++;
    if (req.headers.authorization === `Bearer ${VALID_KEY}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ domains: [{ id: 'dom_1', name: 'stub.example' }] }));
    } else {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    }
  } else {
    res.writeHead(404).end('{}');
  }
});

(async () => {
  await new Promise((r) => stub.listen(5800, '127.0.0.1', r));
  const STUB = 'http://127.0.0.1:5800';

  // org with an admin and a member on the allow-private server
  const adminEmail = `admin-${crypto.randomBytes(3).toString('hex')}@bridge.test`;
  const r = await req('POST', '/api/auth/setup', { email: adminEmail, password: 'Bridge-pass-12345', orgName: 'Bridge Org', setupToken: SETUP_TOKEN });
  if (r.status !== 200) throw new Error(`setup ${r.status}: ${r.body}`);
  const admin = cookies(r);
  const memberEmail = `member-${crypto.randomBytes(3).toString('hex')}@bridge.test`;
  const inv = await req('POST', '/api/ui/org/invites', { email: memberEmail, role: 'member' }, { cookie: admin });
  const link = JSON.parse(inv.body).link;
  const tok = link.split('/invite/')[1];
  const reg = await req('POST', `/api/auth/invites/${tok}`, { email: memberEmail, password: 'Bridge-pass-12345' });
  if (reg.status !== 200) throw new Error(`invite register ${reg.status}: ${reg.body}`);
  const member = await login(DC, memberEmail, 'Bridge-pass-12345');

  // 1. key format refused before any network call
  const before = stubHits;
  const badFmt = await req('POST', '/api/ui/org/multies-connection', { base_url: STUB, workspace_label: 'Stub WS', api_key: 'not-a-multies-key' }, { cookie: admin });
  check('non-mm_live_ key refused without calling Multies', '400, 0 stub calls', `${badFmt.status}, ${stubHits - before} stub calls`, badFmt.status === 400 && stubHits === before);

  // 2. a key Multies rejects is not bound
  const rej = await req('POST', '/api/ui/org/multies-connection', { base_url: STUB, workspace_label: 'Stub WS', api_key: 'mm_live_wrong_key_123' }, { cookie: admin });
  check('Multies-rejected key not bound', 400, rej.status, rej.status === 400);

  // 3. members cannot bind
  const memTry = await req('POST', '/api/ui/org/multies-connection', { base_url: STUB, workspace_label: 'Stub WS', api_key: VALID_KEY }, { cookie: member });
  check('member bind refused', 403, memTry.status, memTry.status === 403);

  // 4. valid key binds
  const ok = await req('POST', '/api/ui/org/multies-connection', { base_url: STUB, workspace_label: 'Stub WS', api_key: VALID_KEY }, { cookie: admin });
  check('valid key binds', 200, ok.status, ok.status === 200);

  // 5. stored: hash only, never the raw key (checked against the database URL the harness passes)
  const { execSync } = require('child_process');
  const raw = execSync(`psql "${process.env.DATABASE_URL}" -tAc "SELECT key_hash, key_hint, workspace_label FROM multies_connections"`).toString().trim();
  const expectHash = crypto.createHash('sha256').update(VALID_KEY).digest('hex');
  check('connection row stores sha256 hash and label', `${expectHash}|${VALID_KEY.slice(-4)}|Stub WS`, raw, raw === `${expectHash}|${VALID_KEY.slice(-4)}|Stub WS`);
  const leak = execSync(`psql "${process.env.DATABASE_URL}" -tAc "SELECT count(*) FROM multies_connections WHERE key_hash LIKE '%mm_live%' OR workspace_label LIKE '%mm_live%'"`).toString().trim();
  check('raw key nowhere in connection row', '0', leak, leak === '0');

  // 6. GET shows the binding redacted
  const got = await req('GET', '/api/ui/org/multies-connection', null, { cookie: admin });
  const gj = JSON.parse(got.body);
  check('GET returns redacted binding', true, gj.bound === true && gj.key_hint.endsWith(VALID_KEY.slice(-4)) && !got.body.includes(VALID_KEY), gj.bound === true && gj.key_hint.endsWith(VALID_KEY.slice(-4)) && !got.body.includes(VALID_KEY));

  // 7. member can read the (redacted) binding
  const memGet = await req('GET', '/api/ui/org/multies-connection', null, { cookie: member });
  check('member reads redacted binding', 200, memGet.status, memGet.status === 200 && !memGet.body.includes(VALID_KEY));

  // 8. re-bind replaces
  const ok2 = await req('POST', '/api/ui/org/multies-connection', { base_url: STUB, workspace_label: 'Stub WS Renamed', api_key: VALID_KEY }, { cookie: admin });
  const cnt = execSync(`psql "${process.env.DATABASE_URL}" -tAc "SELECT count(*), max(workspace_label) FROM multies_connections"`).toString().trim();
  check('re-bind replaces the single row', '1|Stub WS Renamed', cnt, ok2.status === 200 && cnt === '1|Stub WS Renamed');

  // 9. unbind
  const del = await req('DELETE', '/api/ui/org/multies-connection', null, { cookie: admin });
  const after = JSON.parse((await req('GET', '/api/ui/org/multies-connection', null, { cookie: admin })).body);
  check('unbind removes the binding', 'false', String(after.bound), del.status === 200 && after.bound === false);

  // 10. private/local destinations refused when not explicitly allowed
  if (DCB) {
    const r2 = await req('POST', '/api/auth/setup', { email: `block-${crypto.randomBytes(3).toString('hex')}@bridge.test`, password: 'Bridge-pass-12345', orgName: 'Block Org', setupToken: SETUP_TOKEN }, {}, DCB);
    const adminB = cookies(r2);
    const blocked = await req('POST', '/api/ui/org/multies-connection', { base_url: STUB, workspace_label: 'Stub WS', api_key: VALID_KEY }, { cookie: adminB }, DCB);
    check('private Multies URL refused without MONITORING_ALLOW_PRIVATE_WEBHOOKS', 400, blocked.status, blocked.status === 400);
  }

  stub.close();
  const failed = results.filter((x) => !x.pass);
  console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, results }, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
