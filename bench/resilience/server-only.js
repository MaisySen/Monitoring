#!/usr/bin/env node
// Server-only resilience variant for environments where the Monitoring Agent binary cannot be built.
// Numbered telemetry flows app (@monitoring/trace) -> Monitoring server OTLP intake -> Postgres while a
// fault is injected. This exercises the server, the database and the client libraries' retry budget; it
// does NOT cover the agent's disk-backed queue (see bench/resilience/README.md for the full-pipeline
// claims, which still need an agent binary to re-verify).
//
//   MONITORING_URL=http://127.0.0.1:4300 MONITORING_API_KEY=... DATABASE_URL=postgresql://... \
//   ORG_ID=1 SERVER_START_CMD='...' PG_RESTART_CMD='...' node bench/resilience/server-only.js
//
//   SCENARIOS=baseline,db_restart,server_outage_short,server_outage_long (default: all four)
//   RATE=100 SECONDS=60 bound each scenario; faults fire at FAULT_AT_S (default 20).
//   server_outage_short downs the server for 15 s (inside the libraries' default 30 s retry budget:
//   zero loss expected); server_outage_long downs it for 45 s (bounded loss expected and measured).
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');

const BASE = (process.env.MONITORING_URL || 'http://127.0.0.1:4300').replace(/\/$/, '');
const ORG = process.env.ORG_ID || '1';
const RATE = Number(process.env.RATE || 100);
const SECONDS = Number(process.env.SECONDS || 60);
const FAULT_AT = Number(process.env.FAULT_AT_S || 20);
const SCENARIOS = (process.env.SCENARIOS || 'baseline,db_restart,server_outage_short,server_outage_long').split(',');
const SERVER_PATTERN = process.env.SERVER_PATTERN || '[d]ist/index.mjs';
const SERVER_START_CMD = process.env.SERVER_START_CMD || '';
const PG_RESTART_CMD = process.env.PG_RESTART_CMD || '';
const GEN_NODE_MODULES = process.env.GEN_NODE_MODULES || '/tmp/resgen/node_modules';

const sh = (c) => execSync(c, { encoding: 'utf8', shell: '/bin/bash' }).trim();
const psql = (q) => sh(`psql "${process.env.DATABASE_URL}" -X -tAc "${q.replace(/"/g, '\\"')}"`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pids = (pat) => { try { return sh(`pgrep -f "${pat}" || true`).split('\n').filter(Boolean); } catch { return []; } };

async function waitHttp(url, want, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const code = sh(`curl -s -o /dev/null -w "%{http_code}" --max-time 3 "${url}" || true`);
      if (code === String(want)) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function restartServer() {
  if (!SERVER_START_CMD) throw new Error('SERVER_START_CMD required for outage scenarios');
  spawn('bash', ['-c', SERVER_START_CMD], { detached: true, stdio: 'ignore' }).unref();
  return waitHttp(BASE + '/login', 200, 60000);
}

const faults = {
  baseline: { run: async () => ({ cleared: Date.now(), down_s: 0 }) },
  db_restart: { run: async () => {
    if (!PG_RESTART_CMD) throw new Error('PG_RESTART_CMD required for db_restart');
    const t0 = Date.now();
    sh(PG_RESTART_CMD);
    return { cleared: Date.now(), down_s: (Date.now() - t0) / 1000 };
  } },
  server_outage_short: { run: async () => {
    pids(SERVER_PATTERN).forEach((p) => { try { process.kill(Number(p), 'SIGKILL'); } catch {} });
    await sleep(15000);
    const ok = await restartServer();
    return { cleared: Date.now(), down_s: 15, restarted: ok };
  } },
  server_outage_long: { run: async () => {
    pids(SERVER_PATTERN).forEach((p) => { try { process.kill(Number(p), 'SIGKILL'); } catch {} });
    await sleep(45000);
    const ok = await restartServer();
    return { cleared: Date.now(), down_s: 45, restarted: ok };
  } },
};

async function runScenario(name) {
  const svc = `resilience-so-${name}`;
  const t0 = Date.now();
  // gen.js runs from the directory holding GEN_NODE_MODULES so its bare requires (winston,
  // @monitoring/trace) resolve there; copy gen.js next to GEN_NODE_MODULES before running.
  const genDir = path.dirname(GEN_NODE_MODULES);
  const gen = spawn('node', ['-r', path.join(GEN_NODE_MODULES, '@monitoring/trace/init'), path.join(genDir, 'gen.js')], {
    cwd: path.dirname(GEN_NODE_MODULES),
    env: {
      ...process.env, RATE: String(RATE), SECONDS: String(SECONDS),
      MONITORING_SERVICE: svc,
      OTEL_EXPORTER_OTLP_ENDPOINT: BASE,
      OTEL_EXPORTER_OTLP_HEADERS: `DC-API-KEY=${process.env.MONITORING_API_KEY}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  gen.stderr.on('data', (c) => (err += c));
  gen.on('exit', (code, sig) => process.stderr.write(`  ${name}: generator exited code=${code} sig=${sig}\n`));
  process.stderr.write(`  ${name}: generator pid=${gen.pid}\n`);
  // Resolve when the generator prints its {"spans":..,"logs":..} summary line, then stop the child.
  // (Waiting for a natural 'exit' is unreliable: OTEL timers can keep the process alive and a lost
  // SIGCHLD leaves the promise pending forever.)
  // Poll for the summary line or child death: SIGCHLD/'exit' has proven unreliable in this
  // environment (lost notifications left a zombie child and a permanently pending promise).
  let resolveSent;
  const sentP = new Promise((resolve) => (resolveSent = resolve));
  const finish = () => {
    try { resolveSent(JSON.parse(out.trim().split('\n').pop())); } catch { resolveSent({ spans: 0, logs: 0, parse_error: out.slice(-200) }); }
  };
  gen.stdout.on('data', (c) => {
    out += c;
    const line = out.trim().split('\n').pop();
    try {
      const j = JSON.parse(line);
      if (typeof j.spans === 'number') resolveSent(j);
    } catch {}
  });
  // Zombie-safe liveness: kill(pid, 0) succeeds on zombies in this environment, so also watch the
  // clock - if the summary has not arrived SECONDS+45s after spawn, take whatever stdout we have.
  const childWatch = setInterval(() => {
    if (!gen.pid) return;
    let dead = false;
    try { process.kill(gen.pid, 0); } catch { dead = true; }
    if (!dead) { try { dead = require('fs').readFileSync(`/proc/${gen.pid}/stat`, 'utf8').split(' ')[2] === 'Z'; } catch { dead = true; } }
    if (dead) { clearInterval(childWatch); finish(); }
  }, 1000);
  const hardTimeout = setTimeout(() => {
    process.stderr.write(`  ${name}: generator summary timeout; stderr tail: ${err.slice(-300)}\n`);
    finish();
  }, (SECONDS + 45) * 1000);
  sentP.then(() => clearTimeout(hardTimeout));
  sentP.then(() => {
    clearInterval(childWatch);
    setTimeout(() => { try { gen.kill('SIGKILL'); } catch {} }, 500).unref();
  });

  await sleep(FAULT_AT * 1000);
  const faultStart = Date.now();
  const info = await faults[name].run();

  const sent = await sentP;

  // Wait for stored counts to stabilize, then count unique/duplicate sequence numbers.
  let counts = { spans_rows: 0, spans_unique: 0, logs_rows: 0, logs_unique: 0 }, stableSince = Date.now(), last = '';
  let firstAfter = null;
  while (Date.now() - t0 < SECONDS * 1000 + 180000) {
    if (firstAfter === null) {
      try {
        const v = psql(`select min(start_ms) from spans where org_id=${ORG} and service='${svc}' and start_ms > ${info.cleared}`);
        if (v) firstAfter = (Number(v) - info.cleared) / 1000;
      } catch {}
    }
    let c;
    try {
      const s = psql(`select count(*), count(distinct metrics->>'seq') from spans where org_id=${ORG} and service='${svc}' and start_ms >= ${t0 - 5000}`);
      const l = psql(`select count(*), count(distinct attributes->>'seq') from logs where org_id=${ORG} and service='${svc}' and ts >= ${t0 - 5000}`);
      const [sc, su] = s.split('|').map(Number), [lc, lu] = l.split('|').map(Number);
      c = { spans_rows: sc, spans_unique: su, logs_rows: lc, logs_unique: lu };
    } catch { await sleep(2000); continue; }
    const key = JSON.stringify(c);
    if (key !== last) { last = key; counts = c; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 20000) break;
    if (counts.spans_unique >= sent.spans && counts.logs_unique >= sent.logs && Date.now() - stableSince > 5000) break;
    process.stderr.write(`  ${name}: stored ${counts.spans_unique}/${sent.spans} spans ${counts.logs_unique}/${sent.logs} logs\n`);
    await sleep(2000);
  }

  return {
    scenario: name, service: svc, rate_spans_per_s: RATE, seconds: SECONDS,
    fault_started_s: (faultStart - t0) / 1000, fault: info,
    sent, stored: counts,
    spans_missing: sent.spans - counts.spans_unique, spans_duplicates: counts.spans_rows - counts.spans_unique,
    logs_missing: sent.logs - counts.logs_unique, logs_duplicates: counts.logs_rows - counts.logs_unique,
    first_span_after_recovery_s: firstAfter,
    stderr_tail: err.slice(-300),
  };
}

(async () => {
  const results = [];
  for (const s of SCENARIOS) {
    if (!faults[s]) { console.error('unknown scenario ' + s); continue; }
    process.stderr.write(`running ${s}\n`);
    results.push(await runScenario(s));
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
