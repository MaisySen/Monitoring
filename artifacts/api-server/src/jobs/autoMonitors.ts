import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { evaluateMonitor } from "./monitors";

/**
 * Default monitors, auto-created the first time a service sends spans. These are honest
 * starting points, not tuned detection: sustained errors and silence. Thresholds are a
 * stated hypothesis (see docs/PRODUCT-PLAN.md); the user tunes or deletes them, and the
 * monitoring.auto:true tag keeps them identifiable. Creation never blocks or fails intake.
 */
const done = new Set<string>(); // org|service cache; a restart re-checks the DB

function clean(s: string): string {
  return s.replace(/["\\]/g, " ").trim() || "unknown";
}

export async function ensureServiceMonitors(orgId: number, service: string): Promise<void> {
  const svc = clean(service);
  const cacheKey = `${orgId}|${svc}`;
  if (done.has(cacheKey)) return;
  done.add(cacheKey);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Two intake processes can see the same new service at once; the advisory lock makes the
    // existence check + insert atomic across them.
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`auto-mon:${orgId}:${svc}`]);
    const exists = await c.query("select 1 from monitors where org_id=$1 and tags @> $2::text[] limit 1", [orgId, [`auto:service:${svc}`]]);
    if (exists.rows.length) {
      await c.query("COMMIT");
      return;
    }
    const ins = async (name: string, type: string, query: string, message: string, options: object): Promise<number> => {
      const r = (
        await c.query(
          "insert into monitors (org_id, name, type, query, message, tags, priority, options, creator_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
          [orgId, name, type, query, message, ["monitoring.auto:true", `auto:service:${svc}`, `service:${svc}`], null, options, "Monitoring"],
        )
      ).rows[0];
      return r.id as number;
    };
    const ids: number[] = [];
    ids.push(
      await ins(
        `[Default] Errors in ${svc}`,
        "trace-analytics alert",
        `spans("service:${svc} status:error").rollup("count").last("10m") >= 5`,
        `5 or more error spans in ${svc} within 10 minutes. This is a default starting threshold, not tuned detection - tune it to your traffic. The service page lists the failing operations and an example trace.`,
        {},
      ),
    );
    ids.push(
      await ins(
        `[Default] ${svc} stopped sending data`,
        "trace-analytics alert",
        `spans("service:${svc}").rollup("count").last("10m") < 0`, // never true with data: OK while receiving, No Data when silent
        `${svc} sent no trace data for 10 minutes. It may be down, redeploying, or simply idle - Monitoring cannot tell the difference from silence alone.`,
        { notify_no_data: true, no_data_timeframe: 10 },
      ),
    );
    await c.query("COMMIT");
    logger.info({ orgId, service: svc, ids }, "default monitors created for new service");
    for (const id of ids) evaluateMonitor(id).catch((e) => logger.warn({ err: String(e), id }, "auto monitor first evaluation failed"));
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    done.delete(cacheKey); // allow the next batch to retry
    logger.warn({ err: e, orgId, service: svc }, "auto monitor creation failed");
  } finally {
    c.release();
  }
}
