#!/usr/bin/env node
// Failure-recovery test: numbered spans and logs flow app (@monitoring/trace) -> Monitoring Agent -> Monitoring server ->
// Postgres while one part of the pipeline is broken. For each scenario we count what arrived (unique sequence numbers),
// what is missing, what arrived twice, and how long until fresh data was visible again after the fault cleared.
//
//   SCENARIOS=baseline,backend_outage,agent_restart,db_restart,long_outage node recovery.js > recovery-results.json
//
// Faults (process patterns are overridable: SERVER_PATTERN, SERVER_LOOP_PATTERN, AGENT_PATTERN, PG_RESTART_CMD):
//   backend_outage  Monitoring API server down for 60 s (restart loop paused, server killed): the agent must queue + retry
//   agent_restart   Monitoring Agent killed and restarted: the libraries must retry; the agent's disk queue must survive
//   db_restart      Postgres restarted (fast shutdown): the server's intake fails until it is back; the agent retries
//   long_outage     server down for 240 s at 3x the rate, sized to overflow the agent's queue: shows where data drops
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FB = require('../lib/env').deps();
const SCENARIOS = (process.env.SCENARIOS || 'baseline,backend_outage,agent_restart,db_restart,long_outage').split(',');
const LANG = process.env.GEN_LANG || 'node'; // node | python
const RUN = process.env.RUN || Math.random().toString(36).slice(2, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const psql = (q) => sh(`psql "${process.env.DATABASE_URL}" -tAc "${q.replace(/"/g, '\\"')}"`);
const tryPsql = (q) => { try { return psql(q); } catch { return null; } };
const pids = (pattern) => { try { return sh(`pgrep -f '${pattern}'`).split('\n').filter(Boolean).map(Number); } catch { return []; } };

const SERVER = process.env.SERVER_PATTERN || '[n]ode --enable-source-maps artifacts/api-server/dist/index.mjs';
const SERVER_LOOP = process.env.SERVER_LOOP_PATTERN || '[a]rtifacts/api-server && env';
const AGENT = process.env.AGENT_PATTERN || '[d]atacat-agent run -c';
const faults = {
  baseline: { at: 30, run: async () => ({ cleared: Date.now() }) },
  backend_outage: { at: 30, run: async () => {
    const loops = pids(SERVER_LOOP); loops.forEach((p) => process.kill(p, 'SIGSTOP'));
    pids(SERVER).forEach((p) => process.kill(p, 'SIGKILL'));
    await sleep(60000);
    loops.forEach((p) => process.kill(p, 'SIGCONT'));
    return { cleared: Date.now(), down_s: 60 };
  } },
  long_outage: { at: 20, rate: 600, seconds: 300, run: async () => {
    const loops = pids(SERVER_LOOP); loops.forEach((p) => process.kill(p, 'SIGSTOP'));
    pids(SERVER).forEach((p) => process.kill(p, 'SIGKILL'));
    await sleep(240000);
    loops.forEach((p) => process.kill(p, 'SIGCONT'));
    return { cleared: Date.now(), down_s: 240 };
  } },
  agent_restart: { at: 30, run: async () => {
    // The agent is expected to run under a restart loop (systemd Restart=always or a shell loop); SIGTERM it and wait until the new
    // process is listening on :4318 again.
    const t = Date.now();
    const old = pids(AGENT);
    old.forEach((p) => process.kill(p, 'SIGTERM'));
    for (let i = 0; i < 300; i++) {
      const now = pids(AGENT).filter((p) => !old.includes(p));
      if (now.length && sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:13133/ || true') === '200') break; // agent health_check
      await sleep(100);
    }
    return { cleared: Date.now(), down_s: (Date.now() - t) / 1000 };
  } },
  db_restart: { at: 30, run: async () => {
    const t = Date.now();
    sh(`${process.env.PG_RESTART_CMD || 'sudo systemctl restart postgresql'} > /tmp/pg-restart.log 2>&1`);
    return { cleared: Date.now(), down_s: (Date.now() - t) / 1000 };
  } },
};

async function scenario(name) {
  const f = faults[name];
  const svc = `recovery-${LANG}-${name.replace(/_/g, '-')}-${RUN}`;
  const rate = f.rate || 200, seconds = f.seconds || 90;
  const t0 = Date.now();
  const genEnv = { ...process.env, NODE_PATH: `${FB}/node/node_modules`, MONITORING_SERVICE: svc, MONITORING_ENV: 'resilience', RATE: String(rate), SECONDS: String(seconds) };
  const gen = LANG === 'python'
    ? spawn(`${FB}/venv/bin/monitoring-run`, [`${FB}/venv/bin/python`, path.join(__dirname, 'gen.py')], { env: genEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('node', ['-r', `${FB}/node/node_modules/@monitoring/trace/init`, path.join(__dirname, 'gen.js')], { env: genEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  gen.stdout.on('data', (d) => (out += d)); gen.stderr.on('data', (d) => (err += d));
  const exited = new Promise((r) => gen.on('exit', r));
  await sleep(f.at * 1000);
  const faultStart = Date.now();
  const info = await f.run();
  // time until a span created after the fault cleared is visible in Monitoring
  let freshAt = null;
  for (let i = 0; i < 600 && !freshAt; i++) {
    const v = tryPsql(`select count(*) from spans where org_id=1 and service='${svc}' and start_ms > ${info.cleared}`);
    if (v && Number(v) > 0) freshAt = Date.now(); else await sleep(500);
  }
  await exited;
  const sent = JSON.parse(out.trim().split('\n').pop() || '{}');
  // drain: wait until counts stop changing for 20 s (max 6 min)
  let last = -1, stableSince = Date.now(), counts;
  const drainStart = Date.now();
  while (Date.now() - drainStart < 360000) {
    const s = tryPsql(`select count(*), count(distinct metrics->>'seq') from spans where org_id=1 and service='${svc}' and start_ms >= ${t0 - 5000}`);
    const l = tryPsql(`select count(*), count(distinct attributes->>'seq') from logs where org_id=1 and service='${svc}' and ts >= ${t0 - 5000}`);
    if (s && l) {
      const [sc, su] = s.split('|').map(Number), [lc, lu] = l.split('|').map(Number);
      counts = { spans_rows: sc, spans_unique: su, logs_rows: lc, logs_unique: lu };
      if (sc + lc !== last) { last = sc + lc; stableSince = Date.now(); }
      else if (Date.now() - stableSince > 20000 && (su >= sent.spans || Date.now() - stableSince > 60000)) break;
    }
    await sleep(5000);
  }
  const r = {
    scenario: name, lang: LANG, service: svc, rate_spans_per_s: rate, seconds, fault_started_s: (faultStart - t0) / 1000, fault_duration_s: info.down_s ?? 0,
    sent, ...counts,
    spans_missing: sent.spans - counts.spans_unique, spans_duplicates: counts.spans_rows - counts.spans_unique,
    logs_missing: sent.logs - counts.logs_unique, logs_duplicates: counts.logs_rows - counts.logs_unique,
    seconds_to_fresh_data_after_recovery: freshAt ? (freshAt - info.cleared) / 1000 : null,
    seconds_to_fully_drained_after_end: (stableSince - drainStart) / 1000,
    generator_stderr: err.slice(-400) || undefined,
  };
  process.stderr.write(JSON.stringify(r) + '\n');
  return r;
}

(async () => {
  const results = [];
  for (const s of SCENARIOS) { results.push(await scenario(s)); await sleep(5000); }
  console.log(JSON.stringify({ run: RUN, results }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
