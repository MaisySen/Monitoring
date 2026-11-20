import app from "./app";
import { logger } from "./lib/logger";
import { startMonitorLoop, startRetentionLoop } from "./jobs/monitors";
import { startUptimeLoop } from "./jobs/uptime";
import { migrateDatabase, buildBackgroundIndexes } from "./lib/migrate";
import { storage, useClickHouse } from "./lib/storage";
import { ensureChSchema } from "./lib/ch";
import { pool } from "@workspace/db";
import { generatedSetupToken } from "./routes/auth";
import { ensureSpanStats, flushSpanStats } from "./query/apmStats";

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

await migrateDatabase();
if (useClickHouse) await ensureChSchema();
// The rollup table must exist (and any backfill must be computed from pre-boot spans only) BEFORE
// intake can record: a lazy first ensure would backfill spans that intake has already recorded
// into the pending in-memory aggregates, double-counting them (measured 2026-11-21: service
// catalog showed exactly 2x root spans on a fresh install). ensureSpanStats is a no-op under
// ClickHouse and after the first call.
await ensureSpanStats();
logger.info({ storage }, "telemetry storage");
if (generatedSetupToken && !(await pool.query("select 1 from users limit 1")).rowCount) {
  logger.warn(`First-run setup token (enter it on the setup page): ${generatedSetupToken}`);
}
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  // Run several API processes against one database by giving all but one MONITORING_BACKGROUND_JOBS=false, so monitors
  // are evaluated (and notifications sent) by exactly one process.
  if (String(process.env.MONITORING_BACKGROUND_JOBS ?? "true").toLowerCase() !== "false") {
    startMonitorLoop();
    startUptimeLoop();
    startRetentionLoop();
    void buildBackgroundIndexes((msg, extra) => logger.info(extra ?? {}, msg));
  } else logger.info("background jobs disabled (MONITORING_BACKGROUND_JOBS=false)");
});

// On SIGTERM/SIGINT: stop accepting connections, let requests in progress finish (up to MONITORING_SHUTDOWN_SECONDS,
// default 25), flush pending APM rollups, close the database pool, then exit.
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.once(sig, () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal: sig }, "shutting down");
    const limitMs = Math.max(1, Number(process.env.MONITORING_SHUTDOWN_SECONDS ?? 25)) * 1000;
    const force = setTimeout(() => {
      logger.warn("shutdown time limit reached; exiting");
      process.exit(0);
    }, limitMs);
    force.unref();
    server.close(async () => {
      await flushSpanStats().catch((e) => logger.warn({ err: e }, "final span stats flush failed"));
      await pool.end().catch(() => undefined);
      process.exit(0);
    });
    server.closeIdleConnections?.();
  });
