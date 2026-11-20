#!/usr/bin/env node
// Uptime probe concurrency verification: two API workers against one database, disposable
// local targets only (requires servers started with the test-only MONITORING_UPTIME_ALLOW_PRIVATE).
//
// Proves, with real races:
//   1. Exclusivity: each due check is probed exactly once per interval even with two workers
//      ticking on their own cadence (the conditional claim UPDATE re-checks next_run_at on
//      the locked row, so the loser of a race claims nothing).
//   2. Fairness: with a big org holding more due checks than the per-org tick cap (5) and the
//      global tick limit (10) under contention, a small org's checks are still probed in the
//      first round; the big org's excess waits for later ticks (oldest-due-first ordering).
//
// Usage: TARGET_URL=http://127.0.0.1:4799/slow DATABASE_URL=... node bench/uptime/concurrency.js
// Expects two workers already running against DATABASE_URL. Cleans up everything it creates.
import { execFileSync } from "node:child_process";

const DB = process.env.DATABASE_URL;
const TARGET = process.env.TARGET_URL ?? "http://127.0.0.1:4799/slow";
if (!DB) throw new Error("DATABASE_URL required");

const psql = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", DB, "-c", sql], { encoding: "utf8" }).split("\n").filter((l) => l.trim() && !/^[A-Z]+( \d+)*$/.test(l.trim())).join("\n").trim();
const psql1 = (sql) => psql(sql).split("\n")[0];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

const t0 = Date.now();
// Two scratch orgs; the big one gets 8 due checks (over the 5/org tick cap), the small one 2.
const big = Number(psql1(`insert into orgs (name) values ('conc-big-${t0}') returning id`));
const small = Number(psql1(`insert into orgs (name) values ('conc-small-${t0}') returning id`));
const ids = { big: [], small: [] };
for (let i = 0; i < 8; i++)
  ids.big.push(Number(psql1(`insert into uptime_checks (org_id, name, url, interval_s, timeout_ms, enabled, created_at, next_run_at)
    values (${big}, 'big-${i}', '${TARGET}', 30, 8000, true, ${t0}, ${t0}) returning id`)));
for (let i = 0; i < 2; i++)
  ids.small.push(Number(psql1(`insert into uptime_checks (org_id, name, url, interval_s, timeout_ms, enabled, created_at, next_run_at)
    values (${small}, 'small-${i}', '${TARGET}', 30, 8000, true, ${t0}, ${t0}) returning id`)));

const idList = [...ids.big, ...ids.small].join(",");
// Round 1 lands after one tick plus the slow-probe duration; round 2 (big org's remainder)
// after the next tick. Wait long enough for both, well inside the 30s interval.
await new Promise((r) => setTimeout(r, 14_000));

try {
  const rows = psql(`select check_id, count(*) from uptime_results where check_id in (${idList}) and ts >= ${t0} group by check_id order by check_id`)
    .split("\n")
    .map((l) => l.split("|"));
  const countBy = new Map(rows.map(([id, n]) => [Number(id), Number(n)]));
  const dupes = [...countBy.entries()].filter(([, n]) => n > 1);
  check("exclusivity: no check probed twice in one interval across two workers", dupes.length === 0, dupes.length ? `dupes: ${dupes.map(([i, n]) => `${i}x${n}`).join(",")}` : `${countBy.size} checks, one result each`);

  const bigCount = ids.big.filter((id) => countBy.has(id)).length;
  const smallCount = ids.small.filter((id) => countBy.has(id)).length;
  check("fairness: small org's 2 checks probed despite big org's 8 due", smallCount === 2, `${smallCount}/2 probed`);
  check("fairness: big org capped at 5 in round 1, remainder probed in round 2", bigCount === 8, `${bigCount}/8 probed after two rounds`);

  // Round-1 timing: the small org's results must land early (first probe round), not after
  // the big org's backlog drains.
  const firstTs = psql(`select c.name, min(r.ts) from uptime_results r join uptime_checks c on c.id = r.check_id
    where r.check_id in (${idList}) and r.ts >= ${t0} group by c.name order by min(r.ts)`);
  const smallFirst = firstTs.split("\n").filter((l) => l.startsWith("small")).map((l) => Number(l.split("|")[1]));
  const round1End = t0 + 10_000;
  check("fairness: small org's first results landed in the first probe round", smallFirst.every((ts) => ts <= round1End), `small first results at +${smallFirst.map((ts) => ts - t0).join(",")}ms`);

  const fails = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ total: results.length, passed: results.length - fails.length, results }, null, 1));
  process.exitCode = fails.length ? 1 : 0;
} finally {
  psql(`delete from uptime_results where check_id in (${idList})`);
  psql(`delete from uptime_checks where id in (${idList})`);
  psql(`delete from orgs where id in (${big}, ${small})`);
}
