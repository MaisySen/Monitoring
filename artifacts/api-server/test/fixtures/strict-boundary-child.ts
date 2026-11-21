// Real production route/store/PG boundary controls. Only signed lease timing and
// paused COMMIT are fixture instrumentation; no production hook or alternate store.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import protobuf from "protobufjs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { migrateDatabase } from "../../src/lib/migrate";
import { invalidateQuotas, bytesThisMinute, usageToday } from "../../src/lib/quotas";
import {
  strictClock,
  strictReceipt,
  closeStrictClock,
  sweepStrict,
  strictLosses,
  STRICT_GRACE,
  recordStrictDiagnostic,
} from "../../src/lib/strictMetricDelivery";
process.env.MONITORING_METRIC_DIRECT_TEST_ONLY = "yes";
process.env.MONITORING_METRIC_DIRECT_TEST_SECRET = "synthetic-direct-delivery-secret-for-local-test";
const { default: app } = await import("../../src/app");
await migrateDatabase();
await pool.query(
  "insert into orgs(id,name) values(1,'boundary'),(2,'isolated');insert into api_keys(org_id,name,key,kind) values(1,'api','edge-1-api','api'),(2,'api','edge-2-api','api')",
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.on("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/otlp/experimental/metric-delivery/v1`;
const root = protobuf
  .parse(
    `syntax="proto3";message Export {repeated RM resource_metrics=1;}message RM{repeated SM scope_metrics=2;}message SM{repeated M metrics=2;}message M{string name=1;S sum=7;}message S{repeated P data_points=1;int32 aggregation_temporality=2;bool is_monotonic=3;}message P{fixed64 time_unix_nano=3;double as_double=4;}`,
  )
  .root.lookupType("Export");
const body = (name: string) =>
  Buffer.from(
    root
      .encode(
        root.fromObject({
          resourceMetrics: [
            {
              scopeMetrics: [
                {
                  metrics: [
                    {
                      name,
                      sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ timeUnixNano: String(BigInt(Date.now()) * 1000000n), asDouble: 7 }] },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      )
      .finish(),
  );
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function post(path: string, b: any, org = 1, token?: string) {
  return fetch(base + path, {
    method: "POST",
    headers: {
      "DC-API-KEY": `edge-${org}-api`,
      "content-type": Buffer.isBuffer(b) ? "application/x-protobuf" : "application/json",
      ...(token ? { "x-monitoring-delivery-token": token } : {}),
    },
    body: Buffer.isBuffer(b) ? b : JSON.stringify(b),
  });
}
async function lease(b: Buffer, ttl?: number) {
  const r = await post("/lease", { sha: sha(b) });
  assert.equal(r.status, 200);
  const l = await r.json();
  if (ttl !== undefined) {
    const x = JSON.parse(Buffer.from(l.token.split(".")[0], "base64url").toString());
    x.until = (await strictClock()) + ttl;
    await pool.query("update metric_direct_leases set until_ms=$1 where batch_id=$2", [x.until, l.id]);
    const encoded = Buffer.from(JSON.stringify(x)).toString("base64url");
    l.token = encoded + "." + createHmac("sha256", process.env.MONITORING_METRIC_DIRECT_TEST_SECRET!).update(encoded).digest("base64url");
    l.until = x.until;
  }
  return l;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let release: () => void = () => {},
  entered: () => void = () => {},
  pause = false;
let paused = new Promise<void>((r) => (entered = r));
let barrier = new Promise<void>((r) => (release = r));
const PgClient = (pool as any).Client;
const original = PgClient.prototype.query;
(PgClient.prototype as any).query = function (...args: any[]) {
  const text = String(typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "")).toLowerCase();
  if (text.startsWith("update metric_direct_receipts set accepted") || text.startsWith("delete from metric_direct_leases")) (this as any).__strictWriter = true;
  if (text === "commit" && (this as any).__strictWriter) {
    (this as any).__strictWriter = false;
    if (pause) {
      pause = false;
      entered();
      return barrier.then(() => original.apply(this, args as any));
    }
  }
  return original.apply(this, args as any);
};
function arm() {
  paused = new Promise((r) => (entered = r));
  barrier = new Promise((r) => (release = r));
  pause = true;
}
const out: any = {};
try {
  // Writer passed its final clock check before until, but COMMIT is paused until
  // after it. Receipt must wait, not return expired-unconfirmed from old snapshot.
  const b = body("truth.strict.edge.paused");
  const l = await lease(b, 800);
  arm();
  const sending = post("/metrics", b, 1, l.token);
  await paused;
  await sleep(Math.max(0, l.until - Date.now() + 30));
  let settled = false;
  const receipt = strictReceipt(1, l.token).then((r) => {
    settled = true;
    return r;
  });
  await sleep(120);
  const falseEarly = settled;
  release();
  assert.equal((await sending).status, 200);
  const observed = await receipt;
  assert.equal(falseEarly, false, "receipt must serialize with in-flight writer across expiry");
  assert.equal(observed.state, "stored");
  assert.equal((await post("/metrics", b, 1, l.token)).status, 200, "same identity replay in grace ACKs without adding points");
  out.pausedWriter = { receiptWaited: !falseEarly, observed };
  // Duplicate is ACKed during grace even with byte quota filled by original.
  await pool.query(
    "insert into org_quotas(org_id,max_ingest_bytes_per_minute) values(1,$1) on conflict(org_id) do update set max_ingest_bytes_per_minute=excluded.max_ingest_bytes_per_minute",
    [b.length],
  );
  await pool.query("delete from org_usage_minute where org_id=1");
  invalidateQuotas(1);
  const qbody = body("truth.strict.edge.bytequota");
  await pool.query("update org_quotas set max_ingest_bytes_per_minute=$1 where org_id=1", [qbody.length]);
  invalidateQuotas(1);
  const q = await lease(qbody);
  assert.equal((await post("/metrics", qbody, 1, q.token)).status, 200);
  const charged = await bytesThisMinute(1);
  assert.equal(charged, qbody.length);
  assert.equal((await post("/metrics", qbody, 1, q.token)).status, 200);
  assert.equal(await bytesThisMinute(1), charged);
  out.duplicateQuota = { charged, afterDuplicate: await bytesThisMinute(1) };
  // Raw body and organization mismatches refuse before any points/receipts.
  assert.equal((await post("/metrics", Buffer.concat([qbody, Buffer.from([0])]), 1, q.token)).status, 409);
  assert.equal((await post("/metrics", qbody, 2, q.token)).status, 409);
  assert.equal((await post("/receipt", { token: q.token }, 2)).status, 403);
  out.identityControls = true;
  await pool.query("update org_quotas set max_ingest_bytes_per_minute=null,max_points_per_day=0 where org_id=1");
  invalidateQuotas(1);
  const refusedBody = body("truth.strict.edge.quota");
  const refused = await lease(refusedBody);
  const before = (await pool.query("select count(*) n from metric_points")).rows[0].n;
  assert.equal((await post("/metrics", refusedBody, 1, refused.token)).status, 429);
  assert.equal((await pool.query("select count(*) n from metric_points")).rows[0].n, before);
  assert.equal((await pool.query("select count(*)::int n from metric_direct_receipts where batch_id=$1", [refused.id])).rows[0].n, 0);
  out.quotaRollback = true;
  await pool.query("update org_quotas set max_points_per_day=null where org_id=1");
  invalidateQuotas(1);
  await pool.query("update org_quotas set max_series=0 where org_id=1");
  invalidateQuotas(1);
  const capBody = body("truth.strict.edge.seriescap");
  const capLease = await lease(capBody);
  const pointsBefore = (await pool.query("select count(*) n from metric_points")).rows[0].n;
  const usageBefore = await usageToday(1);
  assert.equal((await post("/metrics", capBody, 1, capLease.token)).status, 429);
  assert.equal((await pool.query("select count(*) n from metric_points")).rows[0].n, pointsBefore);
  assert.equal((await pool.query("select count(*)::int n from metric_direct_receipts where batch_id=$1", [capLease.id])).rows[0].n, 0);
  assert.deepEqual(await usageToday(1), usageBefore);
  await pool.query("update org_quotas set max_series=null where org_id=1");
  invalidateQuotas(1);
  out.seriesQuotaRollback = true;
  // Cleanup starts while writer owns row; after commit it must observe receipt
  // and delete without adding this accepted delivery to loss aggregate.
  const cb = body("truth.strict.edge.cleanup");
  const cl = await lease(cb);
  arm();
  const committing = post("/metrics", cb, 1, cl.token);
  await paused;
  let swept = false;
  const sweeping = sweepStrict(1, cl.until + STRICT_GRACE + 1).then(() => {
    swept = true;
  });
  await sleep(100);
  assert.equal(swept, false);
  release();
  assert.equal((await committing).status, 200);
  await sweeping;
  const aggregate = await strictLosses(1);
  assert.equal(Number(aggregate.count), 2); // daily+series-refused leases are expired by accelerated sweep
  assert.equal((await pool.query("select count(*)::int n from metric_direct_leases where batch_id=$1", [cl.id])).rows[0].n, 0);
  out.cleanupWriter = { serialized: true, refusedLeasesAggregated: Number(aggregate.count) };
  // A delayed safe diagnostic for a removed lease must be a benign no-op.
  await recordStrictDiagnostic(1, cl.token, { localId: randomUUID(), state: "blocked", attempts: 1, retainedBytes: cb.length });
  assert.equal((await pool.query("select count(*)::int n from metric_direct_diagnostics where batch_id=$1", [cl.id])).rows[0].n, 0);
  out.sweptDiagnosticNoop = true;
  const diagBody = body("truth.strict.edge.diagnostic");
  const dl = await lease(diagBody);
  arm();
  const deleting = sweepStrict(1, dl.until + STRICT_GRACE + 1);
  await paused;
  let diagnosed = false;
  const diagnostic = recordStrictDiagnostic(1, dl.token, { localId: randomUUID(), state: "blocked", attempts: 1, retainedBytes: diagBody.length }).then(() => {
    diagnosed = true;
  });
  await sleep(100);
  assert.equal(diagnosed, false);
  release();
  await deleting;
  await diagnostic;
  out.concurrentDiagnosticCleanupNoop = true;
  const lateBody = body("truth.strict.edge.late");
  const late = await lease(lateBody, 80);
  await sleep(100);
  assert.equal((await post("/metrics", lateBody, 1, late.token)).status, 410);
  assert.equal((await strictReceipt(1, late.token)).state, "expired-unconfirmed");
  out.lateArrivalRejected = true;
  // DB-clock rollback fails closed, then recovers only after real server time
  // catches up. Both checks use the same durable singleton, not Date.now mocking.
  const clock = await strictClock();
  await pool.query("update metric_direct_clock set floor_ms=$1 where id=1", [clock + 120]);
  await assert.rejects(strictClock, /clock moved backward/);
  await sleep(150);
  assert.ok((await strictClock()) >= clock + 120);
  out.clockRollbackRecovery = true;
  const holder = await pool.connect();
  await holder.query("begin");
  await holder.query("select * from metric_direct_clock where id=1 for update");
  const blockedAt = Date.now();
  try {
    await assert.rejects(strictClock, (e: any) => e.code === "55P03");
  } finally {
    await holder.query("rollback");
    holder.release();
  }
  assert.ok(Date.now() - blockedAt < 3500, "clock lock contention must fail bounded rather than hang");
  await strictClock();
  out.clockContentionBoundedRecovery = true;
  const rb = body("truth.strict.edge.clockrestart");
  const rl = await lease(rb);
  assert.equal((await post("/metrics", rb, 1, rl.token)).status, 200);
  await pool.query("update metric_direct_clock set floor_ms=$1 where id=1", [(await strictClock()) + 1500]);
  const restarted = await promisify(execFile)(process.execPath, ["--import", "tsx", "test/fixtures/strict-clock-restart-child.ts"], {
    env: { ...process.env, CONTROL_LEASE: rl.token },
    timeout: 8000,
  });
  assert.ok(restarted.stdout.includes("CLOCK_RESTART_RESULT failClosedThenCatchupWithoutReset"));
  out.clockNewProcessRetainsFloorNoReset = true;
  // Wait real elapsed time through the finite 30s grace of the paused-writer
  // lease. No clock mutation for the replay decision; no new identity.
  await sleep(Math.max(0, l.until + STRICT_GRACE - Date.now() + 30));
  assert.equal((await post("/metrics", b, 1, l.token)).status, 410);
  assert.equal((await strictReceipt(1, l.token)).state, "unknown");
  out.elapsedLateGraceRejected = true;
  console.log("BOUNDARY_RESULT " + JSON.stringify(out));
} finally {
  release();
  PgClient.prototype.query = original;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await closeStrictClock();
  await pool.end();
}
