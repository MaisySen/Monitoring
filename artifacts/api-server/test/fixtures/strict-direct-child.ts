import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { pool } from "@workspace/db";
import { closeStrictClock, issueStrictLease, strictClock, sweepStrict, strictLosses, STRICT_GRACE } from "../../src/lib/strictMetricDelivery";
import { createHash } from "node:crypto";
import { migrateDatabase } from "../../src/lib/migrate";
process.env.MONITORING_METRIC_DIRECT_TEST_ONLY = "yes";
process.env.MONITORING_METRIC_DIRECT_TEST_SECRET = "synthetic-direct-delivery-secret-for-local-test";
const { default: app } = await import("../../src/app");
await migrateDatabase();
await pool.query("insert into orgs(id,name) values(1,'strict'),(2,'isolated')");
for (const org of [1, 2])
  for (const kind of ["api", "app"]) await pool.query("insert into api_keys(org_id,name,key,kind) values($1,$2,$3,$2)", [org, kind, `direct-${org}-${kind}`]);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.on("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let mode = "baseline",
  armed = true;
const wire: any[] = [];
const proxy = http.createServer((req, res) => {
  if (req.url === "/fixture-release") {
    armed = false;
    res.end("ok");
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bytes = Buffer.concat(chunks);
    const metric = req.url!.endsWith("/metrics");
    const record: any = {
      sha: createHash("sha256").update(bytes).digest("hex"),
      identity:
        typeof req.headers["x-monitoring-delivery-token"] === "string"
          ? createHash("sha256").update(req.headers["x-monitoring-delivery-token"]).digest("hex")
          : null,
      mode,
      path: req.url,
      bytes: bytes.length,
      hasToken: !!req.headers["x-monitoring-delivery-token"],
    };
    if (metric) wire.push(record);
    if (metric && armed && mode === "blocked") {
      res.writeHead(429);
      res.end("{}");
      record.status = 429;
      return;
    }
    const up = http.request(base + req.url, { method: req.method, headers: req.headers }, (r) => {
      const body: Buffer[] = [];
      r.on("data", (c) => body.push(c));
      r.on("end", () => {
        record.status = r.statusCode;
        if (metric && armed && ["lost-ack", "timeout"].includes(mode) && r.statusCode === 200) {
          armed = false;
          record.fault = mode;
          if (mode === "lost-ack") req.socket.destroy();
          return;
        }
        res.writeHead(r.statusCode!, r.headers);
        res.end(Buffer.concat(body));
      });
    });
    up.on("error", () => {
      res.writeHead(503);
      res.end();
    });
    up.end(bytes);
  });
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const forwarded = `http://127.0.0.1:${(proxy.address() as any).port}`;
const results = [];
process.env.MONITORING_METRIC_DIRECT_TEST_ONLY = "no";
assert.equal((await fetch(base + "/otlp/experimental/metric-delivery/v1/capabilities", { headers: { "DC-API-KEY": "direct-1-api" } })).status, 404);
const disabled = await fetch(base + "/api/ui/metric-delivery", { headers: { "dd-api-key": "direct-1-api", "dd-application-key": "direct-1-app" } });
assert.deepEqual(await disabled.json(), { enabled: false });
assert.equal((await pool.query("select to_regclass('metric_direct_clock') x")).rows[0].x, null);
process.env.MONITORING_METRIC_DIRECT_TEST_ONLY = "yes";
try {
  for (const name of ["baseline", "lost-ack", "timeout", "blocked"]) {
    mode = name;
    armed = true;
    const metric = `truth.strict.${name.replaceAll("-", "_")}.${Date.now()}`;
    const { stdout } = await promisify(execFile)(process.execPath, ["../../bench/correctness/fixtures/strict-direct-app.cjs"], {
      env: {
        ...process.env,
        MONITORING_URL: forwarded,
        MONITORING_API_KEY: "direct-1-api",
        CORRECTNESS_METRIC: metric,
        RECOVER: name === "blocked" ? "yes" : "no",
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
    assert.equal(sdk.actualInit, true);
    assert.equal(sdk.additionalRetries, false);
    assert.ok(sdk.after.every((r: any) => r.state === "stored"));
    if (name === "blocked") {
      assert.equal(sdk.before[0].state, "blocked");
      const sends = wire.filter((w) => w.mode === name);
      assert.equal(sends[0].identity, sends[1].identity);
      assert.equal(sends[0].sha, sends[1].sha);
    }
    const stored = (
      await pool.query(
        "select count(*)::int n,sum(p.value) sum,array_agg(p.value order by p.ts) vals from metric_points p join metric_series s on s.id=p.series_id where s.metric=$1",
        [metric],
      )
    ).rows[0];
    assert.equal(stored.n, 2);
    assert.equal(Number(stored.sum), 18);
    const now = Math.floor(Date.now() / 1000);
    const qr = await fetch(`${base}/api/ui/metrics/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "dd-api-key": "direct-1-api", "dd-application-key": "direct-1-app" },
      body: JSON.stringify({ queries: [{ name: "a", query: `sum:${metric}{*}.as_count()` }], from: now - 120, to: now + 10, interval: 1 }),
    });
    assert.equal(qr.status, 200);
    const q = await qr.json();
    const querySum = q.series.reduce((n: number, s: any) => n + s.pointlist.reduce((a: number, p: any) => a + (p[1] || 0), 0), 0);
    assert.equal(querySum, 18);
    results.push({ name, sdk, stored, querySum, wire: wire.filter((w) => w.mode === name) });
  }
  const concurrency = [];
  mode = "concurrent";
  armed = false;
  for (const count of [5, 8]) {
    const started = Date.now();
    const metrics = Array.from({ length: count }, (_, i) => `truth.strict.concurrent.${count}.${i}.${Date.now()}`);
    await Promise.all(
      metrics.map(async (metric) => {
        const { stdout } = await promisify(execFile)(process.execPath, ["../../bench/correctness/fixtures/strict-direct-app.cjs"], {
          env: {
            ...process.env,
            MONITORING_URL: forwarded,
            MONITORING_API_KEY: "direct-1-api",
            CORRECTNESS_METRIC: metric,
            RECOVER: "no",
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
        const row = (
          await pool.query("select count(*)::int n,sum(p.value) sum from metric_points p join metric_series s on s.id=p.series_id where s.metric=$1", [metric])
        ).rows[0];
        assert.equal(row.n, 2);
        assert.equal(Number(row.sum), 18);
      }),
    );
    concurrency.push({ poolMax: pool.options.max, concurrent: count, completed: count, elapsedMs: Date.now() - started, waiting: pool.waitingCount });
  }
  // One unaccepted lease and one accepted receipt expire together. Aggregate must
  // count only the unconfirmed lease, survive repeated sweeps and org isolation.
  const omitted = await issueStrictLease(1, createHash("sha256").update("never-sent").digest("hex"));
  const now = await strictClock();
  await pool.query("update metric_direct_leases set until_ms=$1 where batch_id=$2", [now - STRICT_GRACE - 1, omitted.id]);
  await pool.query(
    "create function reject_loss() returns trigger language plpgsql as $$begin raise exception 'injected loss failure';end$$;create trigger reject_loss before insert on metric_direct_losses for each row execute function reject_loss()",
  );
  await assert.rejects(sweepStrict(1, now));
  assert.equal(Number((await pool.query("select count(*) n from metric_direct_leases where batch_id=$1", [omitted.id])).rows[0].n), 1);
  assert.equal(Number((await pool.query("select count(*) n from metric_direct_losses")).rows[0].n), 0);
  await pool.query("drop trigger reject_loss on metric_direct_losses;drop function reject_loss()");
  await sweepStrict(1, now);
  await sweepStrict(1, now);
  assert.equal(Number((await strictLosses(1)).count), 1);
  assert.equal(Number((await strictLosses(2)).count), 0);
  const status = await fetch(base + "/api/ui/metric-delivery", { headers: { "dd-api-key": "direct-1-api", "dd-application-key": "direct-1-app" } });
  assert.equal(status.status, 200);
  const shown = await status.json();
  assert.equal(shown.enabled, true);
  assert.equal(shown.receipts.length, 34);
  assert.ok(shown.receipts.every((r: any) => r.synchronousCommit === "on"));
  const isolated = await fetch(base + "/api/ui/metric-delivery", { headers: { "dd-api-key": "direct-2-api", "dd-application-key": "direct-2-app" } });
  assert.deepEqual((await isolated.json()).receipts, []);
  assert.equal((await fetch(base + "/api/ui/metric-delivery")).status, 401);
  assert.equal((await fetch(base + "/otlp/experimental/metric-delivery/v1/capabilities")).status, 403);
  // Report transport/UI authorization only. Synthetic snapshot, not an Agent run.
  process.env.MONITORING_METRIC_CUSTODY_TEST_ONLY = "yes";
  const snapshot = {
    epoch: "a".repeat(32),
    entries: [
      { id: "b".repeat(32), state: "custody", until: Date.now() + 30000, retainUntil: Date.now() + 330000, retainedBytes: 7, attempts: 1, backendId: null },
    ],
    counts: { unconfirmed: 0, refused: 0, stored: 0, first: 0, last: 0 },
    journalFileBytes: 32768,
  };
  const report = await fetch(base + "/otlp/experimental/metric-delivery/v1/agent-status", {
    method: "POST",
    headers: { "DC-API-KEY": "direct-1-api" },
    body: JSON.stringify(snapshot),
  });
  assert.equal(report.status, 200);
  const mirror = await fetch(base + "/api/ui/agent-custody", { headers: { "dd-api-key": "direct-1-api", "dd-application-key": "direct-1-app" } });
  assert.equal(mirror.status, 200);
  const body = await mirror.json();
  assert.equal(body.reports[0].entries[0].receipt, null);
  assert.equal(body.reports[0].entries[0].state, "custody");
  assert.equal((await fetch(base + "/api/ui/agent-custody")).status, 401);
  const other = await fetch(base + "/api/ui/agent-custody", { headers: { "dd-api-key": "direct-2-api", "dd-application-key": "direct-2-app" } });
  assert.deepEqual((await other.json()).reports, []);
  snapshot.entries[0].retainedBytes = -1;
  assert.equal(
    (
      await fetch(base + "/otlp/experimental/metric-delivery/v1/agent-status", {
        method: "POST",
        headers: { "DC-API-KEY": "direct-1-api" },
        body: JSON.stringify(snapshot),
      })
    ).status,
    400,
  );
  console.log(
    "STRICT_RESULT " +
      JSON.stringify({
        results,
        concurrency,
        losses: shown.losses,
        receiptCount: shown.receipts.length,
        synchronousCommitVerified: true,
        orgIsolation: true,
        authenticatedStatus: true,
      }),
  );
} finally {
  proxy.closeAllConnections();
  proxy.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await closeStrictClock();
  await pool.end();
}
