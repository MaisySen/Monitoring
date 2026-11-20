#!/usr/bin/env node
// Multi-organization membership tests against a running Monitoring server.
//
//   MONITORING_URL=http://127.0.0.1:3000 MONITORING_SETUP_TOKEN=... DATABASE_URL=postgresql://... node bench/security/memberships.js
//
// Covers: first-run setup, invite to a second user, creating another organization, switching the active
// organization, per-organization roles (member vs admin), inviting an existing account to another
// organization, role change and member removal, the last-admin guard, session fallback after removal,
// and cross-organization denial through UI routes.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DC = process.env.MONITORING_URL || 'http://127.0.0.1:3000';
const SETUP_TOKEN = process.env.MONITORING_SETUP_TOKEN || '';
const RUN = process.env.RUN || crypto.randomBytes(3).toString('hex');
const psql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -X -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const results = [];
const check = (name, expected, actual, pass) => {
  const r = { area: 'memberships', name, expected, actual, pass: !!pass };
  results.push(r);
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
const pw = () => `Pw-${crypto.randomBytes(12).toString('hex')}`;

async function main() {
  const alice = { email: `alice-${RUN}@example.com`, password: pw() };
  const bob = { email: `bob-${RUN}@example.com`, password: pw() };

  // 1. First-run setup: Alice is admin of organization A.
  let r = await req('POST', '/api/auth/setup', { email: alice.email, password: alice.password, orgName: `Alpha ${RUN}`, setupToken: SETUP_TOKEN });
  check('setup creates first admin', 200, r.status, r.status === 200);
  const aliceCookies = cookieOf(r);
  const meA = json(await req('GET', '/api/auth/user', null, { cookie: aliceCookies }));
  check('alice has one org, active', 1, meA?.orgs?.length, meA?.orgs?.length === 1 && meA.activeOrgId === meA.orgs[0].orgId && meA.orgs[0].role === 'admin');
  const orgA = meA.orgs[0].orgId;

  // 2. Alice invites Bob to A (member); Bob joins with a new account.
  r = await req('POST', '/api/ui/org/invites', { email: bob.email, role: 'member' }, { cookie: aliceCookies });
  const linkA = json(r)?.link;
  check('invite link issued', true, !!linkA, !!linkA);
  const tokenA = linkA.split('/invite/')[1];
  r = await req('POST', `/api/auth/invites/${tokenA}`, { email: bob.email, password: bob.password });
  check('bob joins org A', 200, r.status, r.status === 200);
  const bobCookies = cookieOf(r);
  const meB = json(await req('GET', '/api/auth/user', null, { cookie: bobCookies }));
  check('bob is member of A', 'member', meB?.user?.role, meB?.user?.role === 'member' && meB?.orgs?.length === 1);

  // 3. Bob (member) cannot use admin routes in A.
  r = await req('POST', '/api/ui/org/keys', { name: 'nope', kind: 'api' }, { cookie: bobCookies });
  check('member cannot create keys', 403, r.status, r.status === 403);

  // 4. Alice creates organization C; she is admin of both, active stays A.
  r = await req('POST', '/api/ui/orgs', { name: `Gamma ${RUN}` }, { cookie: aliceCookies });
  const orgC = json(r)?.org?.id;
  check('alice creates org C', true, Number.isInteger(orgC), Number.isInteger(orgC));
  let meA2 = json(await req('GET', '/api/auth/user', null, { cookie: aliceCookies }));
  check('alice has two orgs, A still active', 2, meA2?.orgs?.length, meA2?.orgs?.length === 2 && meA2.activeOrgId === orgA);

  // 5. Switching to C changes what UI routes see; C contains only Alice.
  r = await req('POST', '/api/ui/org/select', { orgId: orgC }, { cookie: aliceCookies });
  check('select org C', 200, r.status, r.status === 200);
  let orgView = json(await req('GET', '/api/ui/org', null, { cookie: aliceCookies }));
  check('C shows only alice', 1, orgView?.members?.length, orgView?.org?.id === orgC && orgView?.members?.length === 1);
  // Alice's API key from A must not read org C routes and vice versa (keys are org-scoped already).
  r = await req('POST', '/api/ui/org/select', { orgId: 999999 }, { cookie: aliceCookies });
  check('select unknown org refused', '403/404', r.status, r.status === 403 || r.status === 404);

  // 6. Alice (active C) invites Bob to C; Bob accepts while signed in.
  r = await req('POST', '/api/ui/org/invites', { email: bob.email, role: 'member' }, { cookie: aliceCookies });
  const tokenC = json(r)?.link?.split('/invite/')[1];
  check('invite to C issued', true, !!tokenC, !!tokenC);
  r = await req('POST', '/api/ui/org/invites/accept', { token: tokenC }, { cookie: bobCookies });
  check('bob accepts C invite signed-in', 200, r.status, r.status === 200);
  const meB2 = json(await req('GET', '/api/auth/user', null, { cookie: bobCookies }));
  check('bob has two orgs', 2, meB2?.orgs?.length, meB2?.orgs?.length === 2);
  // Re-accepting a consumed invite fails.
  r = await req('POST', '/api/ui/org/invites/accept', { token: tokenC }, { cookie: bobCookies });
  check('used invite refused', '4xx', r.status, r.status >= 400 && r.status < 500);

  // 7. Bob switches to C: sees C, still a member (not admin) there.
  await req('POST', '/api/ui/org/select', { orgId: orgC }, { cookie: bobCookies });
  orgView = json(await req('GET', '/api/ui/org', null, { cookie: bobCookies }));
  check('bob sees org C', orgC, orgView?.org?.id, orgView?.org?.id === orgC);
  check('bob member in C', 'member', orgView?.me?.role, orgView?.me?.role === 'member');
  r = await req('POST', '/api/ui/org/keys', { name: 'nope', kind: 'api' }, { cookie: bobCookies });
  check('member cannot create keys in C', 403, r.status, r.status === 403);

  // 8. Bob cannot see org A's data while active in C; org A members list comes from memberships.
  r = await req('POST', '/api/ui/org/select', { orgId: orgA }, { cookie: bobCookies });
  orgView = json(await req('GET', '/api/ui/org', null, { cookie: bobCookies }));
  check('org A lists both members', 2, orgView?.members?.length, orgView?.members?.length === 2);

  // 9. Alice promotes Bob to admin in C; the change is effective on his next request.
  const bobId = meB.user.id;
  r = await req('PATCH', `/api/ui/org/members/${bobId}`, { role: 'admin' }, { cookie: aliceCookies });
  check('alice promotes bob in C', 200, r.status, r.status === 200);
  r = await req('POST', '/api/ui/org/select', { orgId: orgC }, { cookie: bobCookies });
  r = await req('POST', '/api/ui/org/keys', { name: `c-key-${RUN}`, kind: 'api' }, { cookie: bobCookies });
  check('admin bob creates key in C', 200, r.status, r.status === 200);
  r = await req('PATCH', `/api/ui/org/members/${bobId}`, { role: 'member' }, { cookie: aliceCookies });
  check('alice demotes bob in C', 200, r.status, r.status === 200);

  // 10. Last-admin guards in C (Alice is the only admin).
  const aliceId = meA2.user.id;
  r = await req('PATCH', `/api/ui/org/members/${aliceId}`, { role: 'member' }, { cookie: aliceCookies });
  check('last admin cannot self-demote', 400, r.status, r.status === 400);
  r = await req('DELETE', `/api/ui/org/members/${aliceId}`, null, { cookie: aliceCookies });
  check('last admin cannot be removed', 400, r.status, r.status === 400);

  // 11. Remove Bob from C; his session falls back to org A and C is refused.
  r = await req('DELETE', `/api/ui/org/members/${bobId}`, null, { cookie: aliceCookies });
  check('alice removes bob from C', 200, r.status, r.status === 200);
  const meB3 = json(await req('GET', '/api/auth/user', null, { cookie: bobCookies }));
  check('bob back to one org', 1, meB3?.orgs?.length, meB3?.orgs?.length === 1);
  check('session falls back to org A', orgA, meB3?.activeOrgId, meB3?.activeOrgId === orgA && !meB3.restricted);
  r = await req('POST', '/api/ui/org/select', { orgId: orgC }, { cookie: bobCookies });
  check('removed org select refused', 403, r.status, r.status === 403);

  // 12. Role is per-organization: Bob's membership in A is unaffected by C changes.
  orgView = json(await req('GET', '/api/ui/org', null, { cookie: bobCookies }));
  check('bob still member of A', 'member', orgView?.me?.role, orgView?.org?.id === orgA && orgView?.me?.role === 'member');

  // 13. Invite acceptance for a different email is refused.
  r = await req('POST', '/api/ui/org/invites', { email: `carol-${RUN}@example.com`, role: 'member' }, { cookie: aliceCookies });
  const tokenCarol = json(r)?.link?.split('/invite/')[1];
  r = await req('POST', '/api/ui/org/invites/accept', { token: tokenCarol }, { cookie: bobCookies });
  check('invite for another email refused', 403, r.status, r.status === 403);

  // 14. Data-level isolation: telemetry written to org A is invisible while another org is active,
  //     visible after switching back, and gone for a member removed from the org entirely.
  const nowNs = () => String(BigInt(Date.now()) * 1000000n);
  const token = `isolation${RUN}`;
  const otlpLog = (message) => ({
    resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'memiso' } }] }, scopeLogs: [{ scope: { name: 'm' }, logRecords: [{ timeUnixNano: nowNs(), severityText: 'INFO', body: { stringValue: message } }] }] }],
  });
  // The default search window ends at the current whole second, so a log written within the same
  // second is not visible yet; pass an explicit upper bound a few seconds ahead.
  const searchLogs = (cookie) =>
    req('POST', '/api/ui/logs/search', { query: token, limit: 5, from: Math.floor(Date.now() / 1000) - 3600, to: Math.floor(Date.now() / 1000) + 10 }, { cookie });

  await req('POST', '/api/ui/org/select', { orgId: orgA }, { cookie: aliceCookies });
  r = await req('POST', '/api/ui/org/keys', { name: 'iso', kind: 'api' }, { cookie: aliceCookies });
  const keyA = json(r)?.key;
  check('org A api key for isolation', true, !!keyA, !!keyA);
  r = await req('POST', '/otlp/v1/logs', otlpLog(`marker ${token}`), { 'dd-api-key': keyA });
  check('log written to org A', 200, r.status, r.status === 200);

  await req('POST', '/api/ui/org/select', { orgId: orgC }, { cookie: aliceCookies });
  r = await searchLogs(aliceCookies);
  check('A log invisible while C active', 0, json(r)?.total, r.status === 200 && json(r)?.total === 0);
  await req('POST', '/api/ui/org/select', { orgId: orgA }, { cookie: aliceCookies });
  r = await searchLogs(aliceCookies);
  check('A log visible after switching back', 1, json(r)?.total, r.status === 200 && json(r)?.total === 1);

  // Bob is still a member of A only: he can read the log while active in A.
  r = await searchLogs(bobCookies);
  check('member reads org data', 1, json(r)?.total, r.status === 200 && json(r)?.total === 1);
  r = await req('GET', '/api/ui/org/quotas', null, { cookie: bobCookies });
  check('member sees org A usage', 1, json(r)?.usage?.logs, r.status === 200 && json(r)?.usage?.logs === 1);

  // Removing Bob from his last organization ends his data access entirely.
  const orgViewA = json(await req('GET', '/api/ui/org', null, { cookie: aliceCookies }));
  const bobIdA = orgViewA?.members?.find((m) => m.email === bob.email)?.id;
  r = await req('DELETE', `/api/ui/org/members/${bobIdA}`, null, { cookie: aliceCookies });
  check('alice removes bob from A', 200, r.status, r.status === 200);
  r = await searchLogs(bobCookies);
  check('org-less member cannot search logs', true, [401, 403].includes(r.status), [401, 403].includes(r.status));
  r = await req('GET', '/api/ui/org/quotas', null, { cookie: bobCookies });
  check('org-less member cannot read usage', true, [401, 403].includes(r.status), [401, 403].includes(r.status));
  r = await req('POST', '/otlp/v1/logs', otlpLog('should not matter'), { 'dd-api-key': keyA });
  check('intake with org key still works after member removal', 200, r.status, r.status === 200);

  const failed = results.filter((x) => !x.pass);
  console.log(JSON.stringify({ suite: 'memberships', total: results.length, failed: failed.length, results }, null, 1));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
