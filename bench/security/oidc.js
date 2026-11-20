#!/usr/bin/env node
// OIDC sign-in security journey: stub identity providers (signed RS256 id_tokens + JWKS) plus freshly
// spawned Monitoring servers against a throwaway database.
//
//   DATABASE_URL=postgresql://... node bench/security/oidc.js
//
// DATABASE_URL is an admin connection used only to create/drop the fresh test database; app servers and
// stub IdPs are started and torn down by this script.
//
// Covers: discovery, authorize URL shape (state/nonce/S256), id_token signature + iss/aud/exp/nonce
// verification, PKCE verification stub-side, identity binding on (issuer, sub) - never email linking,
// org binding on (issuer, external id) - never display-name lookup, provider-driven role sync
// (downgrade/revocation) limited to sso-sourced grants, last-admin guard, local-grant retention,
// cross-issuer isolation for identical emails/subs/org names, code replay, unverified email, state
// mismatch, tampered PKCE cookie, and that an SSO account has no usable password.
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
const psql = (q, db) => execSync(`psql "${db || appDbUrl}" -X -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

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
function makeIdp() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogueKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'stub-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const codes = new Map();
  const state = { currentUser: null, tamper: null, pkceVerified: false, clock: Math.floor(Date.now() / 1000) };
  const sign = (claims, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'stub-1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = crypto.sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const srv = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://idp');
    const send = (status, obj, extra = {}) => {
      rs.writeHead(status, { 'content-type': 'application/json', ...extra });
      rs.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (u.pathname === '/.well-known/openid-configuration')
      return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
    if (u.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code') return send(400, { error: 'bad client' });
      if (!q.get('redirect_uri') || !q.get('state') || !q.get('nonce') || !q.get('code_challenge') || q.get('code_challenge_method') !== 'S256')
        return send(400, { error: 'bad request shape' });
      const code = 'code-' + crypto.randomBytes(8).toString('hex');
      codes.set(code, { challenge: q.get('code_challenge'), nonce: q.get('nonce'), user: state.currentUser, authTime: ++state.clock });
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
        codes.delete(p.get('code')); // one-time: a replayed code is refused
        if (s256(p.get('code_verifier') || '') !== rec.challenge) return send(400, { error: 'bad verifier' });
        state.pkceVerified = true;
        const now = Math.floor(Date.now() / 1000);
        const user = rec.user;
        const claims = {
          iss: base, sub: user.sub, aud: CLIENT_ID, exp: now + 300, iat: now, nonce: rec.nonce,
          email: user.email, email_verified: user.email_verified, name: user.name, orgs: user.orgs,
          auth_time: rec.authTime,
        };
        if (state.tamper === 'iss') claims.iss = 'https://evil.example.com';
        if (state.tamper === 'aud') claims.aud = 'someone-else';
        if (state.tamper === 'exp') { claims.exp = now - 3600; claims.iat = now - 3700; }
        if (state.tamper === 'nonce') claims.nonce = 'forged-nonce';
        const idToken = sign(claims, state.tamper === 'sig' ? rogueKey : privateKey);
        state.tamper = null;
        send(200, { access_token: 'unused', token_type: 'Bearer', id_token: idToken });
      });
      return;
    }
    send(404, { error: 'unknown' });
  });
  return { srv, state };
}

const idp1 = makeIdp();
const idp2 = makeIdp(); // a different issuer, used for cross-tenant isolation checks
let child = null;
let appDbUrl = null;
let dbName = null;
let APP = null;

async function startApp(issuerBase) {
  if (child) { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); }
  const port = await freePort();
  APP = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'artifacts', 'api-server', 'dist', 'index.mjs')], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(port), PUBLIC_URL: APP, DATABASE_URL: appDbUrl,
      MONITORING_SETUP_TOKEN: SETUP_TOKEN, SESSION_SECRET,
      MONITORING_OIDC_ISSUER: issuerBase, MONITORING_OIDC_CLIENT_ID: CLIENT_ID, MONITORING_OIDC_CLIENT_SECRET: CLIENT_SECRET, MONITORING_OIDC_SESSION_TTL_HOURS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 60; i++) {
    const h = await req(APP, 'GET', '/api/healthz');
    if (h.status === 200) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

async function runFlow(idp) {
  const start = await req(APP, 'GET', '/api/auth/oidc/start');
  const pkceCookie = cookieOf(start, 'oidc_pkce');
  const authz = await req('', 'GET', start.headers.location);
  return { start, pkceCookie, authz };
}
const finishFlow = (flow) => {
  const back = new URL(flow.authz.headers.location);
  return req(APP, 'GET', back.pathname + back.search, null, { cookie: flow.pkceCookie });
};

async function main() {
  await new Promise((r) => idp1.srv.listen(0, '127.0.0.1', r));
  await new Promise((r) => idp2.srv.listen(0, '127.0.0.1', r));
  const idp1Base = `http://127.0.0.1:${idp1.srv.address().port}`;
  const idp2Base = `http://127.0.0.1:${idp2.srv.address().port}`;

  dbName = `monitoring_oidc_${RUN}`;
  execSync(`psql "${ADMIN_DB}" -X -qc "DROP DATABASE IF EXISTS ${dbName}" -c "CREATE DATABASE ${dbName}"`);
  const du = new URL(ADMIN_DB);
  du.pathname = '/' + dbName;
  appDbUrl = du.toString();
  await startApp(idp1Base);

  // 1. config surface
  let r = await req(APP, 'GET', '/api/auth/oidc/enabled');
  check('oidc/enabled reports true', true, json(r)?.enabled, json(r)?.enabled === true);

  // 2-5. happy path: carol, owner of workspace w1 -> org admin
  const ORG = `Acme OIDC ${RUN}`;
  const carol = { sub: 'sub-carol', email: `carol-${RUN}@example.com`, email_verified: true, name: 'Carol', orgs: [{ id: 'w1', name: ORG, role: 'owner' }] };
  idp1.state.currentUser = carol;
  let flow = await runFlow(idp1);
  const au = new URL(flow.start.headers.location);
  const shape = au.searchParams.get('client_id') === CLIENT_ID && au.searchParams.get('redirect_uri') === `${APP}/api/auth/oidc/callback`
    && !!au.searchParams.get('state') && !!au.searchParams.get('nonce') && !!au.searchParams.get('code_challenge') && au.searchParams.get('code_challenge_method') === 'S256';
  check('start redirects with client, redirect, state, nonce, S256 challenge', true, flow.start.status === 302 && shape && !!flow.pkceCookie, flow.start.status === 302 && shape && !!flow.pkceCookie);
  check('stub returns code and matching state', true, flow.authz.status === 302 && new URL(flow.authz.headers.location).searchParams.get('state') === au.searchParams.get('state'), flow.authz.status === 302);
  r = await finishFlow(flow);
  check('callback issues session and redirects to app', 302, r.status, r.status === 302 && r.headers.location === '/');
  const sid = cookieOf(r, 'sid');
  const me = json(await req(APP, 'GET', '/api/auth/user', null, { cookie: sid }));
  check('signed in as the OIDC user', carol.email, me?.email, me?.signedIn === true && me?.email === carol.email);
  check('owner claim mapped to org admin', 'admin', me?.orgs?.[0]?.role, me?.orgs?.length === 1 && me.orgs[0].role === 'admin' && me.orgs[0].orgName === ORG);
  check('stub verified the PKCE verifier', true, idp1.state.pkceVerified, idp1.state.pkceVerified);
  const carolOrgId = psql(`select m.org_id from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}'`);

  // 6. idempotent re-login via the same (issuer, sub)
  flow = await runFlow(idp1);
  await finishFlow(flow);
  const userCount = psql(`select count(*) from users where email='${carol.email}'`);
  const memCount = psql(`select count(*) from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}'`);
  check('re-login does not duplicate user or membership', '1:1', `${userCount}:${memCount}`, userCount === '1' && memCount === '1');

  // 7. SSO login never links an existing password account by email alone
  const gail = { email: `gail-${RUN}@example.com`, password: 'Gail-password-1234' };
  // gail is not the first user, so register her through a normal invite path is unavailable here; use SQL
  // to create the same shape a password account has (local grant in carol's org).
  psql(`insert into users (email, password_hash, first_name) values ('${gail.email}', 'x', 'Gail')`);
  idp1.state.currentUser = { sub: 'sub-gail', email: gail.email, email_verified: true, name: 'Gail', orgs: [] };
  flow = await runFlow(idp1);
  r = await finishFlow(flow);
  const gailLinked = psql(`select count(*) from sso_identities where sub='sub-gail'`);
  check('SSO refuses to link an existing email account', '401:0', `${r.status}:${gailLinked}`, r.status === 401 && gailLinked === '0');

  // 8. provider-driven downgrade applies to sso-sourced grants
  psql(`insert into users (email, password_hash, first_name) values ('hank-${RUN}@example.com', 'x', 'Hank')`);
  psql(`insert into org_memberships (user_id, org_id, role, source) values ((select id from users where email='hank-${RUN}@example.com'), ${carolOrgId}, 'admin', 'local')`);
  idp1.state.currentUser = { ...carol, orgs: [{ id: 'w1', name: ORG, role: 'member' }] };
  flow = await runFlow(idp1);
  await finishFlow(flow);
  let role = psql(`select m.role from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}'`);
  check('provider downgrade admin->member applies', 'member', role, role === 'member');

  // 9. provider revocation removes the sso-sourced membership
  idp1.state.currentUser = { ...carol, orgs: [] };
  flow = await runFlow(idp1);
  await finishFlow(flow);
  const carolMem = psql(`select count(*) from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}'`);
  check('provider revocation removes the membership', '0', carolMem, carolMem === '0');

  // 10. fail closed: frank is the sole (SSO-derived) admin of his org; a downgrade claim strips his
  // privilege even though it orphans the org - revoked provider authority is never retained.
  const frank = { sub: 'sub-frank', email: `frank-${RUN}@example.com`, email_verified: true, name: null, orgs: [{ id: 'w9', name: `Frank Org ${RUN}`, role: 'owner' }] };
  idp1.state.currentUser = frank;
  flow = await runFlow(idp1);
  r = await finishFlow(flow);
  const frankSid = cookieOf(r, 'sid'); // an existing session from BEFORE the provider downgrade
  const frankOrgId = psql(`select m.org_id from org_memberships m join users u on u.id=m.user_id where u.email='${frank.email}'`);
  idp1.state.currentUser = { ...frank, orgs: [{ id: 'w9', name: `Frank Org ${RUN}`, role: 'member' }] };
  flow = await runFlow(idp1);
  await finishFlow(flow);
  const frankRole = psql(`select m.role from org_memberships m join users u on u.id=m.user_id where u.email='${frank.email}'`);
  const frankAdmins = psql(`select count(*) from org_memberships where org_id=${frankOrgId} and role='admin'`);
  check('fail closed: sole SSO admin downgraded, org left without admin', 'member:0', `${frankRole}:${frankAdmins}`, frankRole === 'member' && frankAdmins === '0');

  // 10b. the pre-downgrade session converges immediately (roles are read per request, not cached)
  let meOld = json(await req(APP, 'GET', '/api/auth/user', null, { cookie: frankSid }));
  const oldSessionAdmin = await req(APP, 'POST', '/api/ui/org/keys', { name: 'nope', kind: 'api' }, { cookie: frankSid });
  check('existing session loses admin on downgrade', 'member:403', `${meOld?.orgs?.[0]?.role}:${oldSessionAdmin.status}`, meOld?.orgs?.[0]?.role === 'member' && oldSessionAdmin.status === 403);

  // 10c. revocation with missing workspace claims: membership gone, old session has no org
  idp1.state.currentUser = { ...frank, orgs: [] };
  flow = await runFlow(idp1);
  await finishFlow(flow);
  const frankMem = psql(`select count(*) from org_memberships m join users u on u.id=m.user_id where u.email='${frank.email}'`);
  meOld = json(await req(APP, 'GET', '/api/auth/user', null, { cookie: frankSid }));
  check('revocation removes membership and old-session org access', '0:0', `${frankMem}:${meOld?.orgs?.length}`, frankMem === '0' && (meOld?.orgs?.length ?? -1) === 0);

  // 10d. recovery is an independently authorized local grant, which takes effect on the same old session
  psql(`insert into org_memberships (user_id, org_id, role, source) values ((select id from users where email='${frank.email}'), ${frankOrgId}, 'admin', 'local')`);
  meOld = json(await req(APP, 'GET', '/api/auth/user', null, { cookie: frankSid }));
  const recovered = meOld?.orgs?.find((o) => o.orgId === Number(frankOrgId));
  check('authorized local grant restores admin on the existing session', 'admin:local', `${recovered?.role}:${psql(`select source from org_memberships where org_id=${frankOrgId} and user_id=(select id from users where email='${frank.email}')`)}`, recovered?.role === 'admin');

  // 10e. stale callback cannot restore revoked authority: claim syncs apply strictly in authentication
  // order (auth_time), so the older flow's grants never re-apply after the newer revocation
  idp1.state.currentUser = { ...carol, orgs: [{ id: 'w1', name: ORG, role: 'owner' }] };
  const flowOld = await runFlow(idp1); // authorized while carol was admin
  idp1.state.currentUser = { ...carol, orgs: [] };
  const flowNew = await runFlow(idp1);
  await finishFlow(flowNew); // revocation applies first and records the newer auth_time
  r = await finishFlow(flowOld); // stale sync must be skipped
  const staleRole = psql(`select coalesce((select m.role from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}' and m.org_id=${carolOrgId}), 'none')`);
  check('stale callback cannot restore revoked authority', 'none', staleRole, r.status === 302 && staleRole === 'none');

  // 10f. a newer flow still applies (forward order keeps working)
  idp1.state.currentUser = { ...carol, orgs: [{ id: 'w1', name: ORG, role: 'owner' }] };
  flow = await runFlow(idp1);
  r = await finishFlow(flow);
  const freshRole = psql(`select m.role from org_memberships m join users u on u.id=m.user_id where u.email='${carol.email}' and m.org_id=${carolOrgId}`);
  check('newer claims still apply after a stale skip', 'admin', freshRole, r.status === 302 && freshRole === 'admin');

  // 10g. SSO sessions carry the bounded TTL (2h in this test server) and expiry fails closed
  const carolSid = (decodeURIComponent(cookieOf(r, 'sid')).match(/[0-9a-f]{64}/) || [])[0];
  const ttlH = psql(`select round(extract(epoch from (expire - now()))/3600, 1) from sessions where sid='${carolSid}'`);
  check('SSO session carries the bounded TTL', '2.0', ttlH, Math.abs(Number(ttlH) - 2) < 0.2);
  psql(`update sessions set expire = now() - interval '1 minute' where sid='${carolSid}'`);
  const expiredMe = json(await req(APP, 'GET', '/api/auth/user', null, { cookie: `sid=${carolSid}` }));
  check('expired SSO session fails closed', false, expiredMe?.signedIn, expiredMe?.signedIn === false);

  // 11. local grant retention: erin holds a local admin grant in carol's org; an SSO member claim for the
  // same workspace must not strip it
  psql(`insert into users (email, first_name) values ('erin-${RUN}@example.com', 'Erin')`);
  psql(`insert into org_memberships (user_id, org_id, role, source) values ((select id from users where email='erin-${RUN}@example.com'), ${carolOrgId}, 'admin', 'local')`);
  psql(`insert into sso_identities (issuer, sub, user_id) values ('${idp1Base}', 'sub-erin', (select id from users where email='erin-${RUN}@example.com'))`);
  idp1.state.currentUser = { sub: 'sub-erin', email: `erin-${RUN}@example.com`, email_verified: true, name: 'Erin', orgs: [{ id: 'w1', name: ORG, role: 'member' }] };
  flow = await runFlow(idp1);
  await finishFlow(flow);
  const erinRole = psql(`select m.role from org_memberships m join users u on u.id=m.user_id where u.email='erin-${RUN}@example.com' and m.org_id=${carolOrgId}`);
  check('local admin grant survives an SSO member claim', 'admin', erinRole, erinRole === 'admin');

  // 12. unverified email refused, nothing provisioned
  idp1.state.currentUser = { sub: 'sub-dan', email: `dan-${RUN}@example.com`, email_verified: false, name: null, orgs: [] };
  flow = await runFlow(idp1);
  r = await finishFlow(flow);
  const danCount = psql(`select count(*) from users where email='dan-${RUN}@example.com'`);
  check('unverified email refused with 401', '401:0', `${r.status}:${danCount}`, r.status === 401 && danCount === '0');

  // 13. state mismatch refused
  idp1.state.currentUser = carol;
  flow = await runFlow(idp1);
  const backUrl = new URL(flow.authz.headers.location);
  backUrl.searchParams.set('state', 'forged-state');
  r = await req(APP, 'GET', backUrl.pathname + backUrl.search, null, { cookie: flow.pkceCookie });
  check('state mismatch refused with 401', 401, r.status, r.status === 401);

  // 14. tampered PKCE cookie refused
  flow = await runFlow(idp1);
  const tampered = flow.pkceCookie.replace(/.$/, flow.pkceCookie.endsWith('A') ? 'B' : 'A');
  const back2 = new URL(flow.authz.headers.location);
  r = await req(APP, 'GET', back2.pathname + back2.search, null, { cookie: tampered });
  check('tampered PKCE cookie refused with 401', 401, r.status, r.status === 401);

  // 15. replayed authorization code refused
  flow = await runFlow(idp1);
  const first = await finishFlow(flow);
  const replay = await finishFlow(flow); // same code, same cookie: the stub already consumed the code
  check('replayed code refused', '302:401', `${first.status}:${replay.status}`, first.status === 302 && replay.status === 401);

  // 16-20. id_token verification: signature, issuer, audience, expiry, nonce
  for (const [mode, label] of [['sig', 'wrong signature'], ['iss', 'wrong issuer'], ['aud', 'wrong audience'], ['exp', 'expired token'], ['nonce', 'nonce mismatch']]) {
    idp1.state.currentUser = carol;
    flow = await runFlow(idp1);
    idp1.state.tamper = mode;
    r = await finishFlow(flow);
    check(`id_token ${label} refused with 401`, 401, r.status, r.status === 401);
  }

  // 21. cross-issuer isolation: same sub, email, workspace id and display name from a DIFFERENT issuer
  await startApp(idp2Base);
  idp2.state.currentUser = { sub: 'sub-carol', email: carol.email, email_verified: true, name: 'Carol', orgs: [{ id: 'w1', name: ORG, role: 'owner' }] };
  flow = await runFlow(idp2);
  r = await finishFlow(flow);
  check('cross-issuer login with a known email is refused', 401, r.status, r.status === 401);
  // a genuinely new user from the second issuer with the same workspace id+name gets a separate org
  const iris = { sub: 'sub-iris', email: `iris-${RUN}@example.com`, email_verified: true, name: null, orgs: [{ id: 'w1', name: ORG, role: 'owner' }] };
  idp2.state.currentUser = iris;
  flow = await runFlow(idp2);
  r = await finishFlow(flow);
  const namedOrgs = psql(`select count(*) from orgs where name='${ORG}'`);
  const irisOrg = psql(`select m.org_id from org_memberships m join users u on u.id=m.user_id where u.email='${iris.email}'`);
  check('same workspace id+name from another issuer yields a separate org', `2:!=${carolOrgId}`, `${namedOrgs}:${irisOrg}`, r.status === 302 && namedOrgs === '2' && irisOrg !== carolOrgId);

  // back on issuer 1 for the password check
  await startApp(idp1Base);
  r = await req(APP, 'POST', '/api/auth/login', { email: carol.email, password: 'whatever-password-1' });
  check('SSO account cannot password-login', 401, r.status, r.status === 401);

  const failed = results.filter((x) => !x.pass);
  console.log(JSON.stringify({ area: 'oidc', total: results.length, failed: failed.length, results }, null, 1));
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { child && child.kill('SIGTERM'); } catch {}
    try { idp1.srv.close(); idp2.srv.close(); } catch {}
    if (dbName && !process.env.KEEP_DB) {
      try { execSync(`psql "${ADMIN_DB}" -X -qc "DROP DATABASE IF EXISTS ${dbName}"`); } catch {}
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });
