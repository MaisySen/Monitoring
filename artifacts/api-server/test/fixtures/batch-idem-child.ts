// Child worker for test/batch-idempotency.test.ts. Runs against the scratch database named by
// DATABASE_URL (its module-level pool binds that db). Prints one JSON line of outcomes; the
// parent test asserts them and cross-checks stored rows via psql.
import { migrateDatabase } from "../../src/lib/migrate";
import { writeMetrics, sweepIntakeBatches, DUPLICATE_BATCH, BatchConflict } from "../../src/intake/store";
import { pool } from "@workspace/db";

const orgA = Number(process.env.IDEM_ORG_A);
const orgB = Number(process.env.IDEM_ORG_B);
const out: Record<string, unknown> = {};
const series = (v: number, run: string) => [
  { metric: "idem.t", host: "h1", tags: [`run:${run}`], type: "gauge", points: [[1732400000, v]] as [number, number][] },
];
const count = async (sql: string) => Number(((await pool.query(sql)) as { rows: { count: string }[] }).rows[0].count);

await migrateDatabase();

// first delivery stores; exact retry dedups; changed content conflicts; distinct batch lands
out.first = await writeMetrics(orgA, series(1, "a"), { id: "batchtest-1", sha256: "sha-a" });
out.retry = await writeMetrics(orgA, series(1, "a"), { id: "batchtest-1", sha256: "sha-a" });
try {
  await writeMetrics(orgA, series(2, "a"), { id: "batchtest-1", sha256: "sha-b" });
  out.conflict = false;
} catch (e) {
  out.conflict = e instanceof BatchConflict;
}
out.distinct = await writeMetrics(orgA, series(1, "a"), { id: "batchtest-2", sha256: "sha-a" });
// org isolation: the same batch id in another org is a different batch
out.otherOrg = await writeMetrics(orgB, series(1, "a"), { id: "batchtest-1", sha256: "sha-a" });

// concurrent same-batch deliveries: exactly one ingests, the rest dedup
out.concurrent = await Promise.all(
  [1, 2, 3].map(() =>
    writeMetrics(orgA, series(3, "c"), { id: "batchtest-3", sha256: "sha-c" }).catch((e) => `error:${e}`),
  ),
);

// mid-ingest failure: the claim must roll back WITH the points so a later retry re-ingests
await pool.query(`create function idem_fail() returns trigger language plpgsql as $$ begin raise exception 'forced ingest failure'; end; $$`);
await pool.query(`create trigger fail_points before insert on metric_points for each row execute function idem_fail()`);
try {
  await writeMetrics(orgA, series(9, "rb"), { id: "batchtest-4", sha256: "sha-d" });
  out.rollbackThrew = false;
} catch {
  out.rollbackThrew = true;
}
out.rollbackClaimRows = await count("select count(*) from intake_batches where batch_id='batchtest-4'");
out.rollbackPoints = await count(
  "select count(*) from metric_points mp join metric_series ms on ms.id=mp.series_id where ms.metric='idem.t' and 'run:rb' = any(ms.tags)",
);
await pool.query(`drop trigger fail_points on metric_points`);
out.retryAfterRollback = await writeMetrics(orgA, series(9, "rb"), { id: "batchtest-4", sha256: "sha-d" });
out.retryAfterRollbackPoints = await count(
  "select count(*) from metric_points mp join metric_series ms on ms.id=mp.series_id where ms.metric='idem.t' and 'run:rb' = any(ms.tags)",
);

// bounded retention: sweep removes rows older than the retention window only
await pool.query("update intake_batches set received_at = now() - interval '72 hours' where batch_id='batchtest-2'");
out.swept = await sweepIntakeBatches(48);
out.survivors = await count("select count(*) from intake_batches");

// positive final assertion data for the parent
out.totalPoints = await count(
  "select count(*) from metric_points mp join metric_series ms on ms.id=mp.series_id where ms.metric='idem.t'",
);
console.log(JSON.stringify(out));
