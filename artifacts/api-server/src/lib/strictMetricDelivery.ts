// Explicit connected TEST-ONLY Node-direct/PG contract. No default activation.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Pool, pool } from "@workspace/db";
import { useClickHouse } from "./storage";
export const STRICT_TTL = 30000,
  STRICT_GRACE = 30000;
export class StrictDeliveryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function strictEnabled() {
  return process.env.MONITORING_METRIC_DIRECT_TEST_ONLY === "yes" && !useClickHouse;
}
function gate() {
  if (!strictEnabled()) throw new StrictDeliveryError(404, "Experimental direct metric delivery is unavailable");
  if ((process.env.MONITORING_METRIC_DIRECT_TEST_SECRET || "").length < 32)
    throw new StrictDeliveryError(503, "Experimental signing configuration is unavailable");
  if (pool.options.max! < 1) throw new StrictDeliveryError(503, "Experimental delivery needs a valid DB pool");
}
type Lease = { v: 1; org: number; id: string; sha: string; until: number };
const signature = (s: string) => createHmac("sha256", process.env.MONITORING_METRIC_DIRECT_TEST_SECRET!).update(s).digest("base64url");
export function strictLease(token: string): Lease {
  gate();
  if (token.length > 2048) throw new StrictDeliveryError(400, "Invalid delivery token");
  const [body, mac, ...extra] = token.split(".");
  if (!body || !mac || extra.length) throw new StrictDeliveryError(400, "Invalid delivery token");
  const a = Buffer.from(signature(body)),
    b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new StrictDeliveryError(403, "Invalid delivery signature");
  let x: any;
  try {
    x = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw new StrictDeliveryError(400, "Invalid delivery token");
  }
  if (
    x.v !== 1 ||
    !Number.isSafeInteger(x.org) ||
    x.org < 1 ||
    !Number.isSafeInteger(x.until) ||
    !/^d_[a-f0-9]{32}$/.test(x.id) ||
    !/^[a-f0-9]{64}$/.test(x.sha)
  )
    throw new StrictDeliveryError(400, "Invalid delivery fields");
  return x;
}
let ready: Promise<unknown> | undefined;
export async function strictBootstrap() {
  gate();
  return (ready ??= pool
    .query(
      `create table if not exists metric_direct_clock(id int primary key check(id=1),floor_ms bigint not null);
 insert into metric_direct_clock values(1,0) on conflict do nothing;
 create table if not exists metric_direct_receipts(org_id int not null,batch_id text not null,sha text not null,until_ms bigint not null,accepted int not null default 0,sync_commit text not null,primary key(org_id,batch_id));
 create table if not exists metric_direct_leases(org_id int not null,batch_id text not null,sha text not null,until_ms bigint not null,primary key(org_id,batch_id));
 create table if not exists metric_direct_losses(org_id int primary key,expired_unconfirmed bigint not null default 0,first_until_ms bigint not null,last_until_ms bigint not null);
 create table if not exists metric_direct_diagnostics(org_id int not null,batch_id text not null,local_id text not null,state text not null,attempts int not null,retained_bytes int not null,until_ms bigint not null,primary key(org_id,batch_id),foreign key(org_id,batch_id) references metric_direct_leases(org_id,batch_id) on delete cascade);`,
    )
    .catch((e) => {
      ready = undefined;
      throw e;
    }));
}
// A separate synchronously committed clock observation precedes eligibility decisions.
// Fail CLOSED on backward database clock rather than inventing a trusted absolute time.
let clockPool: InstanceType<typeof Pool> | undefined;
function dedicatedClockPool() {
  return (clockPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    allowExitOnIdle: true,
    options: "-c synchronous_commit=on -c statement_timeout=5000 -c lock_timeout=2000",
  }).on("error", () => {
    /* future clock requests fail closed */
  }));
}
export async function closeStrictClock() {
  if (clockPool) {
    await clockPool.end();
    clockPool = undefined;
  }
}
export async function strictClock() {
  await strictBootstrap();
  const c = await dedicatedClockPool().connect();
  try {
    await c.query("begin");
    await c.query("set local synchronous_commit=on");
    const settings = (await c.query("select current_setting('synchronous_commit') sync,current_setting('fsync') fsync,current_setting('full_page_writes') fpw"))
      .rows[0];
    if (settings.sync !== "on" || settings.fsync !== "on" || settings.fpw !== "on")
      throw new StrictDeliveryError(503, "Durable clock prerequisites unavailable");
    const r = await c.query("select floor_ms,floor(extract(epoch from clock_timestamp())*1000)::bigint now_ms from metric_direct_clock where id=1 for update");
    const now = Number(r.rows[0].now_ms),
      floor = Number(r.rows[0].floor_ms);
    if (now < floor) throw new StrictDeliveryError(503, "Server clock moved backward; wait for durable clock floor, never reset the floor");
    await c.query("update metric_direct_clock set floor_ms=$1 where id=1", [now]);
    await c.query("commit");
    return now;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export async function issueStrictLease(org: number, sha: string) {
  gate();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new StrictDeliveryError(400, "A raw payload SHA256 is required");
  const now = await strictClock();
  await sweepStrict(org, now);
  const x: Lease = { v: 1, org, id: "d_" + randomBytes(16).toString("hex"), sha, until: now + STRICT_TTL };
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      "set local synchronous_commit=on;set local lock_timeout='2s';set local statement_timeout='5s';set local idle_in_transaction_session_timeout='10s'",
    );
    await c.query("select pg_advisory_xact_lock($1,$2)", [183620, org]);
    if (Number((await c.query("select count(*) n from metric_direct_leases where org_id=$1", [org])).rows[0].n) >= 100)
      throw new StrictDeliveryError(429, "Experimental organization lease limit reached");
    await c.query("insert into metric_direct_leases values($1,$2,$3,$4)", [org, x.id, sha, x.until]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
  const encoded = Buffer.from(JSON.stringify(x)).toString("base64url");
  return { token: encoded + "." + signature(encoded), id: x.id, until: x.until, receiptUntil: x.until + STRICT_GRACE };
}
export async function beginStrictWrite(c: any, org: number, id: string, sha: string, token: string) {
  const x = strictLease(token);
  if (x.org !== org || x.id !== id || x.sha !== sha) throw new StrictDeliveryError(409, "Delivery identity/body mismatch");
  await c.query(
    "set local synchronous_commit=on;set local lock_timeout='2s';set local statement_timeout='5s';set local idle_in_transaction_session_timeout='10s'",
  );
  const settings = (
    await c.query(
      "select current_setting('synchronous_commit') as synchronous_commit,current_setting('fsync') as fsync,current_setting('full_page_writes') as full_page_writes",
    )
  ).rows[0];
  const setting = settings.synchronous_commit;
  if (settings.fsync !== "on" || settings.full_page_writes !== "on") throw new StrictDeliveryError(503, "Synchronous storage prerequisites are unavailable");
  if (setting !== "on") throw new StrictDeliveryError(503, "Synchronous metric acceptance is unavailable");
  const owned = (await c.query("select sha,until_ms from metric_direct_leases where org_id=$1 and batch_id=$2 for update", [org, id])).rows[0];
  if (!owned) throw new StrictDeliveryError(410, "Lease no longer retained; do not reidentify these deltas");
  if (owned.sha !== sha || Number(owned.until_ms) !== x.until) throw new StrictDeliveryError(409, "Conflicting retained lease");
  const now = await strictClock();
  const old = await c.query("select sha,until_ms from metric_direct_receipts where org_id=$1 and batch_id=$2", [org, id]);
  if (old.rows.length) {
    if (old.rows[0].sha !== sha || Number(old.rows[0].until_ms) !== x.until) throw new StrictDeliveryError(409, "Conflicting delivery identity");
    if (now > x.until + STRICT_GRACE) throw new StrictDeliveryError(410, "Receipt expired; delivery outcome is no longer retained");
    return { duplicate: true, until: x.until };
  }
  if (now >= x.until) throw new StrictDeliveryError(410, "Delivery expired; do not create a new identity for these deltas");
  await c.query("insert into metric_direct_receipts(org_id,batch_id,sha,until_ms,sync_commit) values($1,$2,$3,$4,$5)", [org, id, sha, x.until, setting]);
  return { duplicate: false, until: x.until };
}
export async function finishStrictWrite(c: any, org: number, id: string, until: number, accepted: number, refused: number) {
  if (refused) throw new StrictDeliveryError(429, "Series capacity refused this strict batch; no points accepted");
  const now = await strictClock();
  if (now >= until) throw new StrictDeliveryError(410, "Delivery expired before final eligibility check");
  await c.query("update metric_direct_receipts set accepted=$3 where org_id=$1 and batch_id=$2", [org, id, accepted]);
}
export async function strictReceipt(org: number, token: string) {
  const x = strictLease(token);
  if (x.org !== org) throw new StrictDeliveryError(403, "Wrong delivery organization");
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local lock_timeout='2s';set local statement_timeout='5s';set local idle_in_transaction_session_timeout='10s'");
    // Same row as the writer and cleanup. If it is still committing, wait or
    // return an unavailable error, never assert expired from an MVCC old view.
    const owned = (await c.query("select sha,until_ms from metric_direct_leases where org_id=$1 and batch_id=$2 for update", [org, x.id])).rows[0];
    const now = await strictClock();
    if (now > x.until + STRICT_GRACE || !owned) {
      await c.query("commit");
      return { state: "unknown", id: x.id, reason: "Receipt horizon ended or lease not retained; do not resend under a new identity" };
    }
    if (owned.sha !== x.sha || Number(owned.until_ms) !== x.until) throw new StrictDeliveryError(409, "Conflicting retained lease");
    const row = (await c.query("select accepted,sync_commit from metric_direct_receipts where org_id=$1 and batch_id=$2 and sha=$3", [org, x.id, x.sha]))
      .rows[0];
    await c.query("commit");
    return row
      ? { state: "stored", id: x.id, accepted: row.accepted, synchronousCommit: row.sync_commit }
      : { state: now >= x.until ? "expired-unconfirmed" : "unconfirmed", id: x.id, reason: "No committed receipt observed after lease-owner serialization" };
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export async function strictStatus(org: number) {
  await strictBootstrap();
  const now = await strictClock();
  return (
    await pool.query(
      'select batch_id as id,accepted,sync_commit as "synchronousCommit",until_ms as until from metric_direct_receipts where org_id=$1 and until_ms+$2>=$3 order by until_ms desc limit 50',
      [org, STRICT_GRACE, now],
    )
  ).rows;
}

export async function recordStrictDiagnostic(org: number, token: string, data: any) {
  const x = strictLease(token);
  if (x.org !== org) throw new StrictDeliveryError(403, "Wrong delivery organization");
  const now = await strictClock();
  if (now > x.until + STRICT_GRACE) return;
  if (
    !/^[a-f0-9-]{36}$/.test(data.localId) ||
    !["sending", "blocked", "expired-unconfirmed", "lost", "stored"].includes(data.state) ||
    !Number.isInteger(data.attempts) ||
    data.attempts < 0 ||
    data.attempts > 3 ||
    !Number.isInteger(data.retainedBytes) ||
    data.retainedBytes < 0 ||
    data.retainedBytes > 1048576
  )
    throw new StrictDeliveryError(400, "Invalid safe diagnostic");

  await pool.query(
    `insert into metric_direct_diagnostics select $1,$2,$3,$4,$5,$6,$7 from metric_direct_leases where org_id=$1 and batch_id=$2 for key share on conflict(org_id,batch_id) do update set state=excluded.state,attempts=excluded.attempts,retained_bytes=excluded.retained_bytes`,
    [org, x.id, data.localId, data.state, data.attempts, data.retainedBytes, x.until],
  );
}
export async function strictDiagnostics(org: number) {
  const now = await strictClock();
  return (
    await pool.query(
      'select batch_id as id,local_id as "localId",state,attempts,retained_bytes as "retainedBytes",until_ms as until from metric_direct_diagnostics where org_id=$1 and until_ms+$2>=$3 order by until_ms desc limit 50',
      [org, STRICT_GRACE, now],
    )
  ).rows;
}

// Each organization sweep owns only its expired rows. A writer holds that SAME
// row until its receipt+metrics commit. Read receipts in a subsequent statement
// after row-lock waits so READ COMMITTED sees the writer's final outcome.
// Counter survives payload/receipt deletion. It describes protocol-visible
// expired-unconfirmed leases, not every sample lost before reaching this server.
export async function sweepStrict(org: number, now: number) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      "set local synchronous_commit=on;set local lock_timeout='2s';set local statement_timeout='5s';set local idle_in_transaction_session_timeout='10s'",
    );
    await c.query("select pg_advisory_xact_lock($1,$2)", [183620, org]);
    const rows = (
      await c.query("select batch_id,until_ms from metric_direct_leases where org_id=$1 and until_ms+$2<$3 order by batch_id for update", [
        org,
        STRICT_GRACE,
        now,
      ])
    ).rows;
    if (rows.length) {
      const ids = rows.map((r) => r.batch_id);
      const lost = (
        await c.query(
          "select l.until_ms from metric_direct_leases l where l.org_id=$1 and l.batch_id=any($2::text[]) and not exists(select 1 from metric_direct_receipts r where r.org_id=l.org_id and r.batch_id=l.batch_id)",
          [org, ids],
        )
      ).rows.map((r) => Number(r.until_ms));
      if (lost.length)
        await c.query(
          "insert into metric_direct_losses values($1,$2,$3,$4) on conflict(org_id) do update set expired_unconfirmed=metric_direct_losses.expired_unconfirmed+excluded.expired_unconfirmed,first_until_ms=least(metric_direct_losses.first_until_ms,excluded.first_until_ms),last_until_ms=greatest(metric_direct_losses.last_until_ms,excluded.last_until_ms)",
          [org, lost.length, Math.min(...lost), Math.max(...lost)],
        );
      await c.query("delete from metric_direct_diagnostics where org_id=$1 and batch_id=any($2::text[])", [org, ids]);
      await c.query("delete from metric_direct_receipts where org_id=$1 and batch_id=any($2::text[])", [org, ids]);
      await c.query("delete from metric_direct_leases where org_id=$1 and batch_id=any($2::text[])", [org, ids]);
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export async function strictLosses(org: number) {
  await sweepStrict(org, await strictClock());
  return (
    (
      await pool.query(
        'select expired_unconfirmed as count,first_until_ms as "firstUntil",last_until_ms as "lastUntil" from metric_direct_losses where org_id=$1',
        [org],
      )
    ).rows[0] ?? { count: 0, firstUntil: null, lastUntil: null }
  );
}
