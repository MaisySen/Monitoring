// Optional agent-reported custody diagnostics. No payloads, secrets or replay.
import { pool } from "@workspace/db";
import { StrictDeliveryError, strictEnabled } from "./strictMetricDelivery";
export const custodyReportsEnabled = () => strictEnabled() && process.env.MONITORING_METRIC_CUSTODY_TEST_ONLY === "yes";
let ready: Promise<unknown> | undefined;
async function bootstrap() {
  if (!custodyReportsEnabled()) throw new StrictDeliveryError(404, "Agent custody reporting disabled");
  return (ready ??= pool
    .query(
      `create table if not exists metric_agent_custody_reports(org_id int not null,epoch text not null,reported_at bigint not null,body jsonb not null,primary key(org_id,epoch))`,
    )
    .catch((e) => {
      ready = undefined;
      throw e;
    }));
}
export async function saveCustodyReport(org: number, b: any) {
  await bootstrap();
  if (!b || !/^[a-f0-9]{32}$/.test(b.epoch) || !Array.isArray(b.entries) || b.entries.length > 128 || !b.counts)
    throw new StrictDeliveryError(400, "Invalid custody snapshot");
  const allowed = ["issued", "custody", "blocked", "stored", "expired-unconfirmed", "refused"];
  const entries = b.entries.map((x: any) => {
    if (
      !/^[a-f0-9]{32}$/.test(x.id) ||
      !allowed.includes(x.state) ||
      !Number.isSafeInteger(x.until) ||
      !Number.isSafeInteger(x.retainUntil) ||
      !Number.isSafeInteger(x.retainedBytes) ||
      x.retainedBytes < 0 ||
      x.retainedBytes > 1048576 ||
      !Number.isInteger(x.attempts) ||
      x.attempts < 0 ||
      x.attempts > 3 ||
      (x.backendId && !/^d_[a-f0-9]{32}$/.test(x.backendId))
    )
      throw new StrictDeliveryError(400, "Invalid custody entry");
    return {
      id: x.id,
      state: x.state,
      until: x.until,
      retainUntil: x.retainUntil,
      retainedBytes: x.retainedBytes,
      attempts: x.attempts,
      backendId: x.backendId || null,
    };
  });
  const counts: Record<string, number> = {};
  for (const k of ["unconfirmed", "refused", "stored", "first", "last"]) {
    if (!Number.isSafeInteger(b.counts[k]) || b.counts[k] < 0) throw new StrictDeliveryError(400, "Invalid custody counter");
    counts[k] = b.counts[k];
  }
  if (!Number.isSafeInteger(b.journalFileBytes) || b.journalFileBytes < 0 || b.journalFileBytes > 134217728)
    throw new StrictDeliveryError(400, "Invalid journal size");
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local lock_timeout='2s';set local statement_timeout='5s'");
    await c.query("select pg_advisory_xact_lock($1,$2)", [183621, org]);
    const n = Number((await c.query("select count(*) n from metric_agent_custody_reports where org_id=$1", [org])).rows[0].n);
    if (n >= 8 && !(await c.query("select 1 from metric_agent_custody_reports where org_id=$1 and epoch=$2", [org, b.epoch])).rowCount)
      throw new StrictDeliveryError(429, "Eight retained agent journals per organization in this experiment");
    await c.query(
      "insert into metric_agent_custody_reports values($1,$2,$3,$4) on conflict(org_id,epoch) do update set reported_at=excluded.reported_at,body=excluded.body",
      [org, b.epoch, Date.now(), JSON.stringify({ entries, counts, journalFileBytes: b.journalFileBytes, maxJournalFileBytes: 134217728 })],
    );
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export async function custodyReports(org: number) {
  await bootstrap();
  const reports = (
    await pool.query('select epoch,reported_at as "reportedAt",body from metric_agent_custody_reports where org_id=$1 order by reported_at desc limit 8', [org])
  ).rows;
  const ids = reports.flatMap((r) => r.body.entries.map((x: any) => x.backendId).filter(Boolean));
  const stored = ids.length
    ? (await pool.query("select batch_id,accepted from metric_direct_receipts where org_id=$1 and batch_id=any($2::text[])", [org, ids])).rows
    : [];
  return reports.map((r) => ({
    ...r.body,
    epoch: r.epoch,
    reportedAt: Number(r.reportedAt),
    entries: r.body.entries.map((x: any) => ({ ...x, receipt: stored.find((s) => s.batch_id === x.backendId) ?? null })),
  }));
}
