// Isolated PG queue-lifecycle study. No production/relay/HTTP imports.
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { inspectExpiryLease, studyServerNow, STUDY_RECEIPT_GRACE_MS } from "./expiryProtocolStudy";
const gate = () => {
  if (process.env.MONITORING_EXPIRY_PROTOCOL_TEST_ONLY !== "yes") throw Error("expiry protocol disabled");
};
export const STUDY_QUEUE_LIMITS = { entries: 16, payloadBytes: 1024, maxBody: 256, maxAttempts: 3 };
export async function bootstrapLifecycleStudy() {
  gate();
  await pool.query(
    `create table if not exists expiry_study_queue(org int not null,id text not null,sha text not null,token text,body bytea,until_ms bigint not null,state text not null,reason text,attempts int not null default 0,primary key(org,id))`,
  );
}
async function locked<T>(fn: (c: any, now: number) => Promise<T>) {
  gate();
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(791123451)");
    const now = await studyServerNow();
    const x = await fn(c, now);
    await c.query("commit");
    return x;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
async function sweep(c: any, now: number) {
  await c.query(
    "update expiry_study_queue set state='expired',body=null,reason='lease expired; no further automatic send' where until_ms<=$1 and state in ('pending','blocked')",
    [now],
  );
  return (await c.query("delete from expiry_study_queue where until_ms+$2<=$1", [now, STUDY_RECEIPT_GRACE_MS])).rowCount;
}
export async function sweepLifecycleStudy() {
  return locked(sweep);
}
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export async function enqueueLifecycleStudy(token: string, org: number, body: Buffer) {
  gate();
  const x = inspectExpiryLease(token);
  if (x.org !== org || x.sha !== digest(body)) throw Error("identity mismatch");
  if (body.length > STUDY_QUEUE_LIMITS.maxBody) throw Error("body limit");
  return locked(async (c, now) => {
    await sweep(c, now);
    const r = await c.query("select * from expiry_study_queue where org=$1 and id=$2", [org, x.id]);
    if (r.rows.length) {
      const row = r.rows[0];
      if (row.sha !== x.sha || Number(row.until_ms) !== x.until) throw Error("identity conflict");
      return row.state;
    }
    if (now >= x.until) throw Error("expired new admission");
    const usage = (await c.query("select count(*)::int n,coalesce(sum(octet_length(body)),0)::int bytes from expiry_study_queue where org=$1", [org])).rows[0];
    if (usage.n >= STUDY_QUEUE_LIMITS.entries || usage.bytes + body.length > STUDY_QUEUE_LIMITS.payloadBytes)
      throw Error("capacity: retained data/receipts; retry after sweep horizon");
    await c.query("insert into expiry_study_queue(org,id,sha,token,body,until_ms,state) values($1,$2,$3,$4,$5,$6,'pending')", [
      org,
      x.id,
      x.sha,
      token,
      body,
      x.until,
    ]);
    return "pending";
  });
}
// attempt is deliberately supplied by tests, not an unbounded background retry loop.
// Its successful return means server confirmed commit OR a durable success receipt.
export async function deliverLifecycleStudy(org: number, id: string, attempt: (token: string, body: Buffer) => Promise<void>) {
  return locked(async (c, now) => {
    await sweep(c, now);
    const r = await c.query("select * from expiry_study_queue where org=$1 and id=$2", [org, id]);
    if (!r.rows.length) throw Error("unknown delivery");
    const row = r.rows[0];
    if (row.state !== "pending") return row.state;
    if (row.attempts >= STUDY_QUEUE_LIMITS.maxAttempts) return "blocked";
    await c.query("update expiry_study_queue set attempts=attempts+1 where org=$1 and id=$2", [org, id]);
    try {
      await attempt(row.token, row.body);
      await c.query("update expiry_study_queue set state='acked',body=null,token=null,reason=null where org=$1 and id=$2", [org, id]);
      return "acked";
    } catch (e: any) {
      await c.query("update expiry_study_queue set state='blocked',reason=$3 where org=$1 and id=$2", [
        org,
        id,
        e?.status === 401
          ? "backend authorization refused"
          : e?.status === 429
            ? "backend backpressure"
            : "delivery outcome unconfirmed; explicit recovery required",
      ]);
      return "blocked";
    }
  });
}
export async function recoverLifecycleStudy(org: number, id: string, approved: boolean) {
  if (!approved) throw Error("explicit recovery approval required");
  return locked(async (c, now) => {
    await sweep(c, now);
    const r = await c.query(
      "update expiry_study_queue set state='pending',reason='explicit bounded recovery requested' where org=$1 and id=$2 and state='blocked' and attempts<$3 returning id",
      [org, id, STUDY_QUEUE_LIMITS.maxAttempts],
    );
    return r.rowCount === 1 ? "pending" : "not-recoverable";
  });
}
export async function statusLifecycleStudy(org: number) {
  return locked(async (c, now) => {
    await sweep(c, now);
    return (
      await c.query(
        "select id,state,reason,attempts,until_ms,coalesce(octet_length(body),0)::int as retained_bytes from expiry_study_queue where org=$1 order by id",
        [org],
      )
    ).rows;
  });
}

// Safe reconciliation after send expiry: only a receipt query, NEVER an ingest attempt.
export async function reconcileLifecycleStudy(org: number, id: string, receipt: (token: string, sha: string) => Promise<boolean>) {
  return locked(async (c, now) => {
    await sweep(c, now);
    const r = await c.query("select * from expiry_study_queue where org=$1 and id=$2", [org, id]);
    if (!r.rows.length) return "unknown";
    const row = r.rows[0];
    if (row.state === "acked") return "acked";
    if (!row.token) return row.state;
    if (await receipt(row.token, row.sha)) {
      await c.query("update expiry_study_queue set state='acked',body=null,token=null,reason=null where org=$1 and id=$2", [org, id]);
      return "acked";
    }
    return row.state;
  });
}
