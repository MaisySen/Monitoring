// Header-bearing PG metric host discovery is part of the points/claim transaction.
// A metadata failure must roll back the claim, points and quota, so the SAME retry can repair.
import assert from "node:assert/strict";
import express from "express";
import { pool } from "@workspace/db";
import { migrateDatabase } from "../../src/lib/migrate";
import intake from "../../src/intake/routes";
import telemetry from "../../src/routes/telemetry";
import { authMiddleware } from "../../src/middlewares/authMiddleware";
import { usageToday } from "../../src/lib/quotas";
await migrateDatabase();
await pool.query("insert into orgs(id,name) values(1,'metadata'),(2,'isolation'),(3,'hostmetrics')");
for (const org of [1, 2, 3])
  for (const kind of ["api", "app"]) await pool.query("insert into api_keys(org_id,name,key,kind) values($1,$2,$3,$2)", [org, kind, `metadata-${org}-${kind}`]);
const app = express();
app.use(intake);
app.use(express.json());
app.use(authMiddleware);
app.use("/api", telemetry);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.on("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const originalNow = Date.now;
let shift = 0;
Date.now = () => originalNow() + shift;
const sec = () => Math.floor(Date.now() / 1000);
function payload(names = ["alpha.requests", "beta.requests"], hostmetrics = false) {
  return Buffer.from(
    JSON.stringify({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "host.name", value: { stringValue: "metadata-host" } },
              { key: "os.type", value: { stringValue: "linux" } },
              { key: "monitoring.agent.version", value: { stringValue: "test-version" } },
            ],
          },
          scopeMetrics: [
            {
              scope: { name: hostmetrics ? "hostmetrics" : "custom" },
              metrics: names.map((name, i) => ({ name, gauge: { dataPoints: [{ timeUnixNano: String(BigInt(sec()) * 1000000000n), asDouble: i ? 11 : 7 }] } })),
            },
          ],
        },
      ],
    }),
  );
}
async function send(bytes: Buffer, id: string | null, org = 1) {
  const r = await fetch(`${base}/otlp/v1/metrics`, {
    method: "POST",
    headers: { "DC-API-KEY": `metadata-${org}-api`, "content-type": "application/json", ...(id ? { "x-monitoring-batch-id": id } : {}) },
    body: bytes,
  });
  await r.arrayBuffer();
  return r.status;
}
async function state(org = 1) {
  return (
    await pool.query(
      `select (select count(*) from metric_points p join metric_series s on s.id=p.series_id where s.org_id=$1)::int as points,(select coalesce(sum(p.value),0) from metric_points p join metric_series s on s.id=p.series_id where s.org_id=$1) as sum,(select count(*) from intake_batches where org_id=$1)::int as claims,(select json_agg(json_build_object('name',name,'apps',apps,'last_seen',last_seen,'os',os,'agentVersion',agent_version)) from hosts where org_id=$1) as hosts`,
      [org],
    )
  ).rows[0];
}
try {
  const bytes = payload();
  await pool.query("create function metadata_fail() returns trigger language plpgsql as $$ begin raise exception 'forced metadata host failure'; end $$");
  await pool.query("create trigger metadata_fail before insert or update on hosts for each row execute function metadata_fail()");
  assert.equal(await send(bytes, "metadata-atomic001"), 503);
  const failed = await state();
  assert.equal(failed.points, 0, "metadata failure must not leave committed points");
  assert.equal(failed.claims, 0, "metadata failure must roll back claim");
  assert.equal(failed.hosts, null);
  assert.equal((await usageToday(1)).points, 0, "point quota must roll back");
  await pool.query("drop trigger metadata_fail on hosts");
  assert.equal(await send(bytes, "metadata-atomic001"), 200);
  const recovered = await state();
  assert.equal(recovered.points, 2);
  assert.equal(Number(recovered.sum), 18);
  assert.equal(recovered.claims, 1);
  assert.deepEqual(recovered.hosts[0].apps, ["alpha", "beta"]);
  assert.equal((await usageToday(1)).points, 2);
  shift = 3600000;
  assert.equal(await send(bytes, "metadata-atomic001"), 200);
  const duplicate = await state();
  assert.deepEqual(duplicate, recovered, "duplicate must not reinsert points or make old host fresh");
  assert.equal(await send(payload(["gamma.requests"]), "metadata-newbatch01"), 200);
  const fresh = await state();
  assert.equal(fresh.points, 3);
  assert.equal(Number(fresh.sum), 25);
  assert.deepEqual(fresh.hosts[0].apps, ["alpha", "beta", "gamma"]);
  assert.ok(Number(fresh.hosts[0].last_seen) >= sec() - 2);
  assert.equal(await send(bytes, "metadata-atomic001", 2), 200);
  const isolated = await state(2);
  assert.equal(isolated.points, 2);
  assert.deepEqual(isolated.hosts[0].apps, ["alpha", "beta"]);
  assert.deepEqual(
    await Promise.all([send(payload(["delta.requests"]), "metadata-concur001"), send(payload(["epsilon.requests"]), "metadata-concur002")]),
    [200, 200],
  );
  const concurrent = await state();
  assert.equal(concurrent.points, 5);
  assert.equal(Number(concurrent.sum), 39);
  assert.deepEqual(concurrent.hosts[0].apps, ["alpha", "beta", "delta", "epsilon", "gamma"]);
  assert.equal(await send(payload(["zeta.requests"]), null), 200);
  const mixed = await state();
  assert.equal(mixed.points, 6);
  assert.deepEqual(mixed.hosts[0].apps, ["alpha", "beta", "delta", "epsilon", "gamma", "zeta"], "unheaded host cache must not overwrite durable app union");
  const hostBytes = payload(["system.test"], true);
  await pool.query("create trigger metadata_fail before insert or update on hosts for each row execute function metadata_fail()");
  assert.equal(await send(hostBytes, "metadata-hostscope01", 3), 503);
  const hostFailed = await state(3);
  assert.equal(hostFailed.points, 0);
  assert.equal(hostFailed.claims, 0);
  assert.equal(hostFailed.hosts, null);
  await pool.query("drop trigger metadata_fail on hosts");
  assert.equal(await send(hostBytes, "metadata-hostscope01", 3), 200);
  const hostRecovered = await state(3);
  assert.equal(hostRecovered.points, 1);
  assert.equal(hostRecovered.hosts[0].os, "linux");
  assert.equal(hostRecovered.hosts[0].agentVersion, "test-version");
  assert.deepEqual(hostRecovered.hosts[0].apps, ["system"]);
  shift += 3600000;
  assert.equal(await send(hostBytes, "metadata-hostscope01", 3), 200);
  assert.deepEqual(await state(3), hostRecovered, "hostmetrics duplicate must not refresh route-level host details");
  const q = new URLSearchParams({ from: String(sec() - 3660), to: String(sec() + 60), query: "avg:gamma.requests{*}" });
  const qr = await fetch(`${base}/api/v1/query?${q}`, { headers: { "dd-api-key": "metadata-1-api", "dd-application-key": "metadata-1-app" } });
  assert.equal(qr.status, 200);
  const query = await qr.json();
  assert.ok(query.series.some((s: any) => s.pointlist.some((p: any) => p[1] === 7)));
  console.log(
    "METADATA_RESULT " +
      JSON.stringify({
        failed,
        recovered,
        duplicateUnchanged: true,
        fresh,
        isolated,
        concurrent,
        mixed,
        hostFailed,
        hostRecovered,
        queryValue: 7,
        semantics: "metadata failure rolls back points+claim+quota; same immutable retry succeeds atomically",
      }),
  );
} finally {
  Date.now = originalNow;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
