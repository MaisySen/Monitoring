// Focused F1-F4 HTTP regression against real PG and the production intake/query routers.
import assert from "node:assert/strict";
import express from "express";
import protobuf from "protobufjs";
import { gzipSync } from "node:zlib";
import { pool } from "@workspace/db";
import { migrateDatabase } from "../../src/lib/migrate";
import intake from "../../src/intake/routes";
import telemetry from "../../src/routes/telemetry";
import { authMiddleware } from "../../src/middlewares/authMiddleware";
import { writeMetrics } from "../../src/intake/store";
import { invalidateQuotas, usageToday } from "../../src/lib/quotas";

await migrateDatabase();
await pool.query("insert into orgs(id,name) values (1,'review'),(2,'quota')");
for (const org of [1, 2])
  for (const kind of ["api", "app"]) await pool.query("insert into api_keys(org_id,name,key,kind) values ($1,$2,$3,$2)", [org, kind, `review-${org}-${kind}`]);
const app = express();
app.use(intake);
app.use(express.json());
app.use(authMiddleware);
app.use("/api", telemetry);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.on("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const out: Record<string, unknown> = {};
const seconds = () => Math.floor(Date.now() / 1000);
const payload = (value: number, metric = "review.requests") =>
  Buffer.from(
    JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "host.name", value: { stringValue: "review-host" } }] },
          scopeMetrics: [
            {
              scope: { name: "review" },
              metrics: [{ name: metric, gauge: { dataPoints: [{ timeUnixNano: String(BigInt(seconds()) * 1000000000n), asDouble: value }] } }],
            },
          ],
        },
      ],
    }),
  );
async function send(bytes: Buffer, id: string, ct = "application/json", encoding?: string, org = 1) {
  const r = await fetch(`${base}/otlp/v1/metrics`, {
    method: "POST",
    headers: { "DC-API-KEY": `review-${org}-api`, "content-type": ct, "x-monitoring-batch-id": id, ...(encoding ? { "content-encoding": encoding } : {}) },
    body: bytes,
  });
  return { status: r.status, ct: r.headers.get("content-type"), bytes: Buffer.from(await r.arrayBuffer()) };
}
async function get(path: string) {
  const r = await fetch(`${base}/api${path}`, { headers: { "dd-api-key": "review-1-api", "dd-application-key": "review-1-app" } });
  assert.equal(r.status, 200, path);
  return r.json();
}
try {
  // F1 warm process caches, move the clock forward, ingest fresh header-bearing data.
  assert.equal((await send(payload(1), "review-initial")).status, 200);
  shift = 3600000;
  const fresh = payload(7);
  assert.equal((await send(fresh, "review-fresh01")).status, 200);
  const q = new URLSearchParams({ from: String(seconds() - 60), to: String(seconds() + 60), query: "avg:review.requests{*}" });
  const query = await get(`/v1/query?${q}`);
  assert.ok(
    query.series.some((s: any) => s.pointlist.some((p: any) => p[1] === 7)),
    "real query must return fresh value after warm-cache +1h",
  );
  const discovery = await get("/ui/metrics?q=review.requests");
  assert.ok(
    discovery.metrics.some((m: any) => m.metric === "review.requests" && Number(m.last_seen) >= seconds() - 2),
    "dashboard discovery last_seen fresh",
  );
  const hosts = await get("/ui/hosts");
  assert.ok(
    hosts.hosts.some((h: any) => h.name === "review-host" && h.apps.includes("review") && Number(h.last_seen) >= seconds() - 2),
    "host is fresh and app-linked",
  );
  out.F1 = { queryValue: 7, discoveryFresh: true, hostAppLinked: true, clockShiftSeconds: 3600 };
  // F2 duplicate success must use the same OTLP encoding as first delivery.
  const jsonDup = await send(fresh, "review-fresh01");
  assert.equal(jsonDup.status, 200);
  assert.match(jsonDup.ct!, /application\/json/);
  assert.deepEqual(JSON.parse(jsonDup.bytes.toString()), {});
  // Minimal wire-compatible OTLP schema, encoded by protobufjs rather than the response encoder.
  const protoType = protobuf
    .parse(
      `syntax = "proto3";
    message Request { repeated ResourceMetrics resource_metrics = 1; }
    message ResourceMetrics { repeated ScopeMetrics scope_metrics = 2; }
    message ScopeMetrics { repeated Metric metrics = 2; }
    message Metric { string name = 1; Gauge gauge = 5; }
    message Gauge { repeated Point data_points = 1; }
    message Point { fixed64 time_unix_nano = 3; double as_double = 4; }
  `,
    )
    .root.lookupType("Request");
  const proto = Buffer.from(
    protoType
      .encode(
        protoType.fromObject({
          resourceMetrics: [
            {
              scopeMetrics: [
                {
                  metrics: [
                    {
                      name: "proto.requests",
                      gauge: { dataPoints: [{ timeUnixNano: String(BigInt(seconds()) * 1000000000n), asDouble: 11 }] },
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
  const protoFirst = await send(proto, "review-proto01", "application/x-protobuf");
  const protoDup = await send(proto, "review-proto01", "application/x-protobuf");
  for (const r of [protoFirst, protoDup]) {
    assert.equal(r.status, 200);
    assert.match(r.ct!, /application\/x-protobuf/);
    assert.equal(r.bytes.length, 0);
  }
  assert.equal(
    Number((await pool.query("select sum(value) as v from metric_points p join metric_series s on s.id=p.series_id where metric='proto.requests'")).rows[0].v),
    11,
    "protobuf duplicate stores its point once",
  );
  out.F2 = { protobufStoredSum: 11, jsonDuplicate: "200 application/json {}", protobufDuplicate: "200 application/x-protobuf empty valid response" };
  // F4 exact compressed-wire-byte protocol, not semantic-body equivalence.
  const compressed = gzipSync(payload(9, "compress.requests"));
  assert.equal((await send(compressed, "review-gzip001", "application/json", "gzip")).status, 200);
  assert.equal((await send(compressed, "review-gzip001", "application/json", "gzip")).status, 200);
  const changed = Buffer.from(compressed);
  changed[4] ^= 1; // gzip mtime only, decompressed payload unchanged
  assert.equal((await send(changed, "review-gzip001", "application/json", "gzip")).status, 409);
  out.F4 = { exactGzipRetry: 200, equivalentPayloadDifferentGzipEnvelope: 409 };
  // F3 force all contenders past the pre-check; authoritative claim serializes them BEFORE quota.
  const pts = [{ metric: "quota.requests", host: "quota-host", tags: [], type: "gauge", points: [[seconds(), 1]] as [number, number][] }];
  await writeMetrics(2, pts); // warm seriesCache before installing a claim delay
  const beforeFailure = (await usageToday(2)).points;
  await pool.query("create function review_points_fail() returns trigger language plpgsql as $$ begin raise exception 'review forced ingest failure'; end $$");
  await pool.query("create trigger review_points_fail before insert on metric_points for each row execute function review_points_fail()");
  await assert.rejects(() => writeMetrics(2, pts, { id: "quota-rollback01", sha256: "same" }), /forced ingest failure/);
  assert.equal((await usageToday(2)).points, beforeFailure, "quota rolled back with failed points");
  assert.equal(Number((await pool.query("select count(*) from intake_batches where batch_id='quota-rollback01'")).rows[0].count), 0);
  await pool.query("drop trigger review_points_fail on metric_points");
  assert.equal(await writeMetrics(2, pts, { id: "quota-rollback01", sha256: "same" }), 0);
  assert.equal((await usageToday(2)).points, beforeFailure + 1, "successful retry charges once");
  await pool.query("delete from org_usage_daily where org_id=2");
  await pool.query("insert into org_quotas(org_id,max_points_per_day) values(2,1)");
  invalidateQuotas(2);
  await pool.query("create function review_claim_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(0.15); return NEW; end $$");
  await pool.query("create trigger review_claim_delay before insert on intake_batches for each row execute function review_claim_delay()");
  const results = await Promise.all([1, 2, 3].map(() => writeMetrics(2, pts, { id: "quota-concurrent", sha256: "same" })));
  assert.equal(results.filter((x) => x === "duplicate").length, 2);
  assert.equal(results.filter((x) => typeof x === "number").length, 1);
  assert.equal((await usageToday(2)).points, 1, "only claim winner consumes point quota");
  // Fresh batch quota refusal rolls claim back, so raising quota permits a retry of the same id.
  await assert.rejects(
    () => writeMetrics(2, pts, { id: "quota-refused001", sha256: "same" }),
    (e: any) => e.quotaReason === "quota:points_per_day",
  );
  assert.equal(Number((await pool.query("select count(*) from intake_batches where batch_id='quota-refused001'")).rows[0].count), 0);
  await pool.query("update org_quotas set max_points_per_day=2 where org_id=2");
  invalidateQuotas(2);
  assert.equal(await writeMetrics(2, pts, { id: "quota-refused001", sha256: "same" }), 0);
  assert.equal((await usageToday(2)).points, 2);
  out.F3 = {
    concurrentResults: results,
    usageAfterConcurrent: 1,
    ingestFailureQuotaRolledBack: true,
    refusedClaimRolledBack: true,
    retryAfterQuotaRaised: true,
  };
  console.log(JSON.stringify(out));
} finally {
  Date.now = realNow;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
