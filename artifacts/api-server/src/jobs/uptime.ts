import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { probeUptime, MAX_CHECKS_CLAIMED_PER_ORG_PER_TICK } from "../lib/uptime";

// Uptime probe loop. Every tick it atomically claims due checks (next_run_at bumped inside
// the same UPDATE ... FOR UPDATE SKIP LOCKED, so multiple API processes never double-probe),
// runs the probes with bounded concurrency, records one uptime_results row per execution and
// updates the check's running state. A check enters the Now problems feed only after
// SURFACE_AFTER_FAILURES consecutive failures, so one flaky probe is not a problem.
export const SURFACE_AFTER_FAILURES = 2;
const TICK_MS = 5_000;
const CLAIM_LIMIT = 10;
const RESULTS_RETENTION_MS = 7 * 24 * 3600 * 1000;

export async function runUptimeCheck(c: {
  id: number;
  org_id: number;
  url: string;
  method: string;
  timeout_ms: number;
  expect_status_min: number;
  expect_status_max: number;
}): Promise<void> {
  let r;
  try {
    r = await probeUptime(c.url, {
      method: c.method === "HEAD" ? "HEAD" : "GET",
      timeoutMs: c.timeout_ms,
      expectMin: c.expect_status_min,
      expectMax: c.expect_status_max,
    });
  } catch (e: any) {
    r = { ok: false, status: null, durationMs: 0, error: String(e?.message ?? e).slice(0, 300), redirects: 0, finalUrl: c.url };
  }
  const now = Date.now();
  await pool.query(
    `insert into uptime_results (org_id, check_id, ts, ok, status_code, duration_ms, error) values ($1,$2,$3,$4,$5,$6,$7)`,
    [c.org_id, c.id, now, r.ok, r.status, Math.round(r.durationMs), r.error],
  );
  await pool.query(
    `update uptime_checks set consecutive_failures = case when $1 then 0 else consecutive_failures + 1 end,
       last_ok=$1, last_checked_at=$2, last_duration_ms=$3, last_error=$4 where id=$5 and org_id=$6`,
    [r.ok, now, Math.round(r.durationMs), r.error, c.id, c.org_id],
  );
}

async function tick(): Promise<void> {
  const now = Date.now();
  // Fair claim: at most MAX_CHECKS_CLAIMED_PER_ORG_PER_TICK due checks per org per tick, so one
  // org with many failing/slow targets cannot starve the others; CLAIM_LIMIT bounds the tick.
  const cand = (
    await pool.query(
      `select id from (select id, row_number() over (partition by org_id order by next_run_at) rn
         from uptime_checks where enabled and next_run_at <= $1) t
       where rn <= $2 order by next_run_at, id limit $3`,
      [now, MAX_CHECKS_CLAIMED_PER_ORG_PER_TICK, CLAIM_LIMIT],
    )
  ).rows.map((r: any) => Number(r.id));
  if (!cand.length) return;
  // Atomic claim: the UPDATE re-checks next_run_at on the locked latest row version, so a
  // second process racing the same check updates 0 rows and does not double-probe.
  const { rows } = await pool.query(
    `update uptime_checks set next_run_at = $1 + interval_s * 1000
     where id = any($2::int[]) and enabled and next_run_at <= $1
     returning id, org_id, url, method, timeout_ms, expect_status_min, expect_status_max`,
    [now, cand],
  );
  // Bounded concurrency: CLAIM_LIMIT checks per tick, 4 at a time, so a batch of slow
  // targets cannot stack up sockets (each probe is also individually time-capped).
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(rows.slice(i, i + 4).map((c: any) => runUptimeCheck(c).catch((e) => logger.warn({ err: String(e), id: c.id }, "uptime probe failed"))));
  }
}

export function startUptimeLoop(): void {
  let running = false;
  const guarded = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      logger.warn({ err: String(e) }, "uptime loop failed");
    } finally {
      running = false;
    }
  };
  setInterval(() => void guarded(), TICK_MS);
  setTimeout(() => void guarded(), 3_000);
  // Results retention: drop probe history older than 7 days, hourly.
  setInterval(() => {
    void pool
      .query("delete from uptime_results where ts < $1", [Date.now() - RESULTS_RETENTION_MS])
      .catch((e) => logger.warn({ err: String(e) }, "uptime results prune failed"));
  }, 3600_000);
}
