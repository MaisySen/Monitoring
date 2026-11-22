import assert from "node:assert/strict";
import type { Server } from "node:http";

// PREPARED SOURCE ONLY. No call at module scope. Caller must create/record a new
// scratch DB and own its OID. This is not an ordinary server startup/migration.
export async function startNormalAgentRealC(expectedName: string, expectedOID: number) {
  assert.equal(process.env.NORMAL_REAL_C_SOURCE_EXECUTE, "reviewed-real-agent-c-v1");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.MONITORING_NODE_APP_CANDIDATE, "test-v1");
  assert.equal(process.env.MONITORING_STORAGE, "postgres");
  assert.equal(process.env.MONITORING_BACKGROUND_JOBS, "false");
  assert.equal(process.env.MONITORING_SYNCHRONOUS_COMMIT, "on");
  assert.match(expectedName, /^candidate_agent_[a-f0-9]{20}$/);
  assert.ok(Number.isSafeInteger(expectedOID) && expectedOID > 0);
  const u = new URL(process.env.DATABASE_URL!);
  assert.equal(u.pathname, "/" + expectedName);
  assert.ok(["127.0.0.1", "[::1]"].includes(u.hostname));
  // No pool or app import until all effect scope checks pass.
  const { pool } = await import("@workspace/db");
  let server: Server | undefined;
  let closeCandidate: (() => Promise<void>) | undefined;
  try {
    const identity = (await pool.query("select current_database() name,(select oid from pg_database where datname=current_database())::bigint oid")).rows[0];
    assert.equal(identity.name, expectedName); assert.equal(Number(identity.oid), expectedOID);
    assert.equal(Number((await pool.query("select count(*) n from pg_tables where schemaname='public'")).rows[0].n), 0, "newly created EMPTY owned DB only");
    const { migrateDatabase } = await import("../../src/lib/migrate");
    await migrateDatabase();
    const { installCandidateScratchSchema } = await import("../../src/lib/candidateAppService");
    const c = await pool.connect();
    try { await installCandidateScratchSchema(c); } finally { c.release(); }
    await pool.query("insert into orgs(id,name) values(1,'normal-agent-real-c-test')");
    // Disposable fixture key only. Never an owner account key. Not emitted.
    await pool.query("insert into api_keys(id,org_id,name,key,kind) values(1,1,'normal-agent-real-c',$1,'api')", ["a".repeat(32)]);
    await pool.query("insert into org_quotas(org_id,max_series,max_points_per_day,max_ingest_bytes_per_minute) values(1,1000,100000,10000000)");
    const actual = await import("../../src/app");
    closeCandidate = actual.closeCandidateApp;
    server = await new Promise<Server>((resolve, reject) => {
      const s = actual.default.listen(0, "127.0.0.1", () => resolve(s));s.once("error", reject);
    });
    const addr = server.address();assert.ok(addr && typeof addr !== "string");
    let stopped = false;
    return {
      origin: "http://127.0.0.1:" + addr.port,
      query: pool.query.bind(pool),
      async close() {
        if(stopped)return;stopped=true;
        const s=server!;s.closeAllConnections();
        await new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()));
        await closeCandidate!();await pool.end();
      },
    };
  } catch {
    if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
    if(closeCandidate)await closeCandidate();
    await pool.end();
    throw Error("owned real-C fixture setup failed; raw error suppressed; preserve DB evidence");
  }
}
