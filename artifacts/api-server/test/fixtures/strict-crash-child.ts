import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool } from "@workspace/db";
import { migrateDatabase } from "../../src/lib/migrate";
process.env.MONITORING_METRIC_DIRECT_TEST_ONLY = "yes";
process.env.MONITORING_METRIC_DIRECT_TEST_SECRET = "synthetic-direct-delivery-secret-for-local-test";
const { closeStrictClock, strictClock } = await import("../../src/lib/strictMetricDelivery");
const { default: app } = await import("../../src/app");
if (process.env.PHASE !== "recheck") {
  await migrateDatabase();
  await pool.query(
    "insert into orgs(id,name) values(1,'crash-control');insert into api_keys(org_id,name,key,kind) values(1,'api','direct-1-api','api'),(1,'app','direct-1-app','app')",
  );
}
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.on("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
try {
  if (process.env.PHASE !== "recheck") {
    const { stdout } = await promisify(execFile)(process.execPath, ["../../bench/correctness/fixtures/strict-direct-app.cjs"], {
      env: {
        ...process.env,
        MONITORING_URL: base,
        MONITORING_API_KEY: "direct-1-api",
        CORRECTNESS_METRIC: "truth.strict.crash",
        MONITORING_METRICS_RETRY: "false",
        OTEL_METRIC_EXPORT_INTERVAL: "3600000",
      },
      timeout: 25000,
    });
    const sdk = JSON.parse(
      stdout
        .split("\n")
        .find((l) => l.startsWith("SDK_RESULT "))!
        .slice(11),
    );
    assert.ok(sdk.after.every((r: any) => r.state === "stored"));
  }
  const clock = await strictClock();
  const settings = (
    await pool.query(
      "select current_setting('synchronous_commit') sync,current_setting('fsync') fsync,current_setting('full_page_writes') fpw,pg_current_wal_lsn()::text current_lsn,pg_current_wal_flush_lsn()::text flushed_lsn,pg_current_wal_flush_lsn()>=pg_current_wal_lsn() flushed",
    )
  ).rows[0];
  assert.equal(settings.sync, "off");
  assert.equal(settings.fsync, "on");
  assert.equal(settings.fpw, "on");
  assert.equal(settings.flushed, true);
  const rows = (
    await pool.query(
      "select count(*)::int n,sum(p.value) sum from metric_points p join metric_series s on s.id=p.series_id where s.metric='truth.strict.crash'",
    )
  ).rows[0];
  assert.equal(rows.n, 2);
  assert.equal(Number(rows.sum), 18);
  const receipts = (await pool.query("select accepted,sync_commit from metric_direct_receipts")).rows;
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((r) => r.sync_commit === "on"));
  const now = Math.floor(Date.now() / 1000);
  const qr = await fetch(base + "/api/ui/metrics/query", {
    method: "POST",
    headers: { "content-type": "application/json", "dd-api-key": "direct-1-api", "dd-application-key": "direct-1-app" },
    body: JSON.stringify({ queries: [{ name: "a", query: "sum:truth.strict.crash{*}.as_count()" }], from: now - 600, to: now + 10, interval: 1 }),
  });
  assert.equal(qr.status, 200);
  const q = await qr.json();
  const querySum = q.series.reduce((n: number, s: any) => n + s.pointlist.reduce((a: number, p: any) => a + (p[1] || 0), 0), 0);
  assert.equal(querySum, 18);
  console.log("CRASH_RESULT " + JSON.stringify({ phase: process.env.PHASE ?? "accept", clock, settings, rows, receipts, querySum }));
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await closeStrictClock();
  await pool.end();
}
