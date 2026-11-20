#!/usr/bin/env node
// OIDC sign-in journey test: a stub identity provider plus a freshly spawned Monitoring server.
//
//   DATABASE_URL=postgresql://... node bench/security/oidc.js
//
// DATABASE_URL is an admin connection used only to create/drop a fresh test database; the app
// server and the stub IdP are started by this script and torn down at the end.
// Covers: provider discovery, authorize redirect shape, PKCE S256 verification (stub side),
// session issuance, org-claim to membership mapping (owner->admin), idempotent re-login,
// unverified-email refusal, state mismatch, tampered PKCE cookie, no-downgrade of an existing
// admin, and that an OIDC account has no usable password.
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const path = require('path');

const ADMIN_DB = process.env.DATABASE_URL;
if (!ADMIN_DB) { console.error('set DATABASE_URL'); process.exit(2); }
const RUN = process.env.RUN || crypto.randomBytes(3).toString('hex');
const SETUP_TOKEN = 'setup-' + RUN;
const SESSION_SECRET = 'oidc-test-secret-' + RUN + '-' + crypto.randomBytes(8).toString('hex');
const CLIENT_ID = 'monitoring';
const CLIENT_SECRET = 'secret-' + RUN;

const results = [];
const check = (name, expected, actual, pass) => {
  results.push({ area: 'oidc', name, expected, actual, pass: !!pass });
  process.stderr.write((pass ? 'ok  ' : 'FAIL') + ' ' + name + (pass ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`) + '\n');
};
const psql = (q, db = ADMIN_DB) => execSync(`psql "${db}" -X -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

function req(base, method, p, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(base + p);
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...(data ? { 'content-length': data.length } : {}), ...(data && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers };
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
const cookieOf = (r, name) =>
  (r.headers['set-cookie'] || [])
    .map((c) => c.split(';')[0])
    .filter((p) => p.startsWith(name + '=') && p.split(/=(.*)/s)[1])
    .map((p) => p.trim())
    .join('; ');
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const s256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');

// ---- stub identity provider ----
let currentUser = null; // set before each flow
const codes = new Map(); // code -> { challenge, user }
const tokens = new Map(); // token -> user
let pkceVerified = false;
const idp = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://idp');
  const send = (status, obj, extra = {}) => {
    rs.writeHead(status, { 'content-type': 'application/json', ...extra });
    rs.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  if (u.pathname === '/.well-known/openid-configuration') {
    const base = `http://127.0.0.1:${idp.address().port}`;
    return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo` });
  }
  if (u.pathname === '/authorize') {
    const q = u.searchParams;
    if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code') return send(400, { error: 'bad client' });
    if (!q.get('redirect_uri') || !q.get('state') || !q.get('code_challenge') || q.get('code_challenge_method') !== 'S256')
      return send(400, { error: 'bad request shape' });
    const code = 'code-' + crypto.randomBytes(8).toString('hex');
    codes.set(code, { challenge: q.get('code_challenge'), user: currentUser });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state'));
    rs.writeHead(302, { location: back.toString() });
    return rs.end();
  }
  if (u.pathname === '/token' && rq.method === 'POST') {
    let b = '';
    rq.on('data', (c) => (b += c));
    rq.on('end', () => {
      const p = new URLSearchParams(b);
      const auth = rq.headers.authorization || '';
      const basic = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
      if (basic !== `${CLIENT_ID}:${CLIENT_SECRET}`) return send(401, { error: 'bad client auth' });
      const rec = codes.get(p.get('code'));
      if (!rec || p.get('grant_type') !== 'authorization_code') return send(400, { error: 'bad code' });
      codes.delete(p.get('code'));
      if (s256(p.get('code_verifier') || '') !== rec.challenge) return send(400, { error: 'bad verifier' });
      pkceVerified = true;
      const tok = 'tok-' + crypto.randomBytes(8).toString('hex');
      tokens.set(tok, rec.user);
      send(200, { access_token: tok, token_type: 'Bearer' });
    });
    return;
  }
  if (u.pathname === '/userinfo') {
    const user = tokens.get((rq.headers.authorization || '').replace(/^Bearer /, ''));
    if (!user) return send(401, { error: 'bad token' });
    return send(200, { sub: user.sub, email: user.email, email_verified: user.email_verified, name: user.name, orgs: user.orgs });
  }
  send(404, { error: 'unknown' });
});

let child = null;
let appDbUrl = null;
let dbName = null;

async function main() {
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  const idpBase = `http://127.0.0.1:${idp.address().port}`;
  const port = await freePort();
  const APP = `http://127.0.0.1:${port}`;

  dbName = `monitoring_oidc_${RUN}`;
  execSync(`psql "${ADMIN_DB}" -X -qc "DROP DATABASE IF EXISTS ${dbName}" -c "CREATE DATABASE ${dbName}"`);
  const u = new URL(ADMIN_DB);
  u.pathname = '/' + dbName;
  appDbUrl = u.toString();

  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'artifacts', 'api-server', 'dist', 'index.mjs')], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      PUBLIC_URL: APP,
      DATABASE_URL: appDbUrl,
      MONITORING_SETUP_TOKEN: SETUP_TOKEN,
      SESSION_SECRET,
      MONITORING_OIDC_ISSUER: idpBase,
      MONITORING_OIDC_CLIENT_ID: CLIENT_ID,
      MONITORING_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    const h = await req(APP, 'GET', '/api/healthz');
    up = h.status === 200;
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error('server did not start');

  // 1. config surface
  let r = await req(APP, 'GET', '/api/auth/oidc/enabled');
  check('oidc/enabled reports true', true, json(r)?.enabled, json(r)?.enabled === true);

  // full browser-style flow; returns { r: callback response, location, pkceCookie }
  const runFlow = async () => {
    const start = await req(APP, 'GET', '/api/auth/oidc/start');
    const pkceCookie = cookieOf(start, 'oidc_pkce');
    const loc = start.headers.location;
    const authz = await req('', 'GET', loc);
    return { start, pkceCookie, loc, authz };
  };
  const finishFlow = async (flow) => {
    const back = new URL(flow.authz.headers.location);
    return req(APP, 'GET', back.pathname + back.search, null, { cookie: flow.pkceCookie });
  };

  // 2-5. happy path with org mapping
  const carol = { sub: 'sub-carol', email: `carol-${RUN}@example.com`, email_verified: true, name: 'Carol', orgs: [{ id: 'w1', name: `Acme OIDC ${RUN}`, role: 'owner' }] };
  currentUser = carol;
  let flow = await runFlow();
  check('start redirects to provider', 302, flow.start.status, flow.start.status === 302);
  const au = new URL(flow.loc);
  const shape = au.searchParams.get('client_id') === CLIENT_ID && au.searchParams.get('redirect_uri') === `${APP}/api/auth/oidc/callback` && !!au.searchParams.get('state') && !!au.searchParams.get('code_challenge') && au.searchParams.get('code_challenge_method') === 'S256';
  check('authorize URL has client, redirect, state, S256 challenge', true, shape, shape);
  check('PKCE cookie set', true, !!flow.pkceCookie, !!flow.pkceCookie);
  check('stub returns code and state', true, flow.authz.status === 302 && new URL(flow.authz.headers.location).searchParams.get('state') === au.searchParams.get('state'), flow.authz.status === 302);
  r = await finishFlow(flow);
  check('callback issues session and redirects to app', 302, r.status, r.status === 302 && r.headers.location === '/');
  const sid = cookieOf(r, 'sid');
  const me = json(await req(APP, 'GET', '/api/auth/user', null, { cookie: sid }));
  check('signed in as the OIDC user', carol.email, me?.email, me?.signedIn === true && me?.email === carol.email);
  check('owner claim mapped to org admin', 'admin', me?.orgs?.[0]?.role, me?.orgs?.length === 1 && me.orgs[0].role === 'admin' && me.orgs[0].orgName === `Acme OIDC ${RUN}`);
  check('stub verified the PKCE verifier', true, pkceVerified, pkceVerified);

  // 6. idempotent re-login: same user, no duplicate membership
  flow = await runFlow();
  r = await finishFlow(flow);
  const userCount = psql(`select count(*) from users where email='${carol.email}'`, appDbUrl);
  const memCount = psql(`select count(*) from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}'`, appDbUrl);
  check('re-login does not duplicate user or membership', '1:1', `${userCount}:${memCount}`, userCount === '1' && memCount === '1');

  // 7. no-downgrade: same user now arrives with a member claim for the same org
  currentUser = { ...carol, orgs: [{ id: 'w1', name: `Acme OIDC ${RUN}`, role: 'member' }] };
  flow = await runFlow();
  r = await finishFlow(flow);
  const role = psql(`select m.role from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}'`, appDbUrl);
  check('member claim does not downgrade existing admin', 'admin', role, role === 'admin');

  // 8. unverified email refused, nothing provisioned
  const dan = { sub: 'sub-dan', email: `dan-${RUN}@example.com`, email_verified: false, name: null, orgs: [] };
  currentUser = dan;
  flow = await runFlow();
  r = await finishFlow(flow);
  const danCount = psql(`select count(*) from users where email='${dan.email}'`, appDbUrl);
  check('unverified email refused with 401', 401, r.status, r.status === 401 && danCount === '0');

  // 9. state mismatch refused
  currentUser = carol;
  flow = await runFlow();
  const backUrl = new URL(flow.authz.headers.location);
  backUrl.searchParams.set('state', 'forged-state');
  r = await req(APP, 'GET', backUrl.pathname + backUrl.search, null, { cookie: flow.pkceCookie });
  check('state mismatch refused with 401', 401, r.status, r.status === 401);

  // 10. tampered PKCE cookie refused
  flow = await runFlow();
  const tampered = flow.pkceCookie.replace(/.$/, flow.pkceCookie.endsWith('A') ? 'B' : 'A');
  const back2 = new URL(flow.authz.headers.location);
  r = await req(APP, 'GET', back2.pathname + back2.search, null, { cookie: tampered });
  check('tampered PKCE cookie refused with 401', 401, r.status, r.status === 401);

  // 11. OIDC account has no usable password
  r = await req(APP, 'POST', '/api/auth/login', { email: carol.email, password: 'whatever-password-1' });
  check('OIDC account cannot password-login', 401, r.status, r.status === 401);

  const failed = results.filter((x) => !x.pass);
  console.log(JSON.stringify({ area: 'oidc', total: results.length, failed: failed.length, results }, null, 1));
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { child && child.kill('SIGTERM'); } catch {}
    try { idp.close(); } catch {}
    if (dbName && !process.env.KEEP_DB) {
      try { execSync(`psql "${ADMIN_DB}" -X -qc "DROP DATABASE IF EXISTS ${dbName}"`); } catch {}
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });
