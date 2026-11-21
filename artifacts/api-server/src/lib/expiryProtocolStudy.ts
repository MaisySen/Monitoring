// ISOLATED TEST-ONLY protocol study. No router/startup imports this module.
// Server-issued capability binds org + immutable ID + raw body hash + expiry.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";
export const STUDY_RECEIPT_GRACE_MS = 30000;
const enabled = () => {
  if (process.env.MONITORING_EXPIRY_PROTOCOL_TEST_ONLY !== "yes") throw Error("expiry protocol disabled");
};
export class ExpiryRefusal extends Error {}
const secret = () => {
  const s = process.env.MONITORING_EXPIRY_TEST_SECRET;
  if (!s || s.length < 32) throw Error("explicit test secret required");
  return s;
};
type Lease = { v: 1; org: number; id: string; sha: string; until: number };
const sign = (s: string) => createHmac("sha256", secret()).update(s).digest("base64url");
export async function bootstrapExpiryStudy() {
  enabled();
  await pool.query(`create table if not exists expiry_study_clock(id int primary key check(id=1),floor_ms bigint not null);
 insert into expiry_study_clock values(1,0) on conflict do nothing;
 create table if not exists expiry_study_claims(org int not null,id text not null,sha text not null,until_ms bigint not null,primary key(org,id));`);
}
// Transaction-scoped clock row intentionally serializes this tiny experiment globally.
// Committed observations retain a high-water mark across restart. The rejected-transaction
// rollback-to-watermark-persist crash gap remains open, not full clock rollback protection.
async function clock(c: any) {
  const r = await c.query(
    `update expiry_study_clock set floor_ms=greatest(floor_ms,floor(extract(epoch from clock_timestamp())*1000)::bigint) where id=1 returning floor_ms`,
  );
  return Number(r.rows[0].floor_ms);
}
export function inspectExpiryLease(token: string): Lease {
  enabled();
  const [body, mac, ...extra] = token.split(".");
  if (extra.length || !body || !mac) throw new ExpiryRefusal("malformed token");
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ExpiryRefusal("invalid token");
  const x = JSON.parse(Buffer.from(body, "base64url").toString());
  if (x.v !== 1 || !Number.isSafeInteger(x.org) || !Number.isSafeInteger(x.until) || !/^s_[a-f0-9]{32}$/.test(x.id) || !/^[a-f0-9]{64}$/.test(x.sha))
    throw new ExpiryRefusal("invalid fields");
  return x;
}
export async function issueExpiryLease(org: number, sha: string, ttlMs = 30000) {
  enabled();
  if (!Number.isSafeInteger(org) || org < 1 || !/^[a-f0-9]{64}$/.test(sha) || !Number.isInteger(ttlMs) || ttlMs < 50 || ttlMs > 30000)
    throw Error("invalid lease parameters");
  const c = await pool.connect();
  try {
    await c.query("begin");
    const now = await clock(c);
    const lease: Lease = { v: 1, org, id: "s_" + randomBytes(16).toString("hex"), sha, until: now + ttlMs };
    const body = Buffer.from(JSON.stringify(lease)).toString("base64url");
    const token = body + "." + sign(body);
    await c.query("commit");
    return { token, lease };
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export async function acceptExpiryLease(token: string, org: number, sha: string, write: (c: any) => Promise<void>) {
  enabled();
  const x = inspectExpiryLease(token);
  if (x.org !== org || x.sha !== sha) throw new ExpiryRefusal("identity mismatch");
  const c = await pool.connect();
  let observed = 0;
  try {
    await c.query("begin");
    let now = await clock(c);
    observed = now;
    const found = await c.query("select sha,until_ms from expiry_study_claims where org=$1 and id=$2", [org, x.id]);
    if (found.rows.length) {
      if (now >= x.until + STUDY_RECEIPT_GRACE_MS) throw new ExpiryRefusal("expired success receipt retired");
      if (found.rows[0].sha !== sha || Number(found.rows[0].until_ms) !== x.until) throw new ExpiryRefusal("claim conflict");
      await c.query("commit");
      return "duplicate";
    }
    if (now >= x.until) throw new ExpiryRefusal("expired at server admission");
    await c.query("insert into expiry_study_claims values($1,$2,$3,$4)", [org, x.id, sha, x.until]);
    await write(c);
    // Re-evaluate DB clock after storage/lock delays, not transaction-stable now().
    now = await clock(c);
    observed = now;
    if (now >= x.until) throw new ExpiryRefusal("expired before final eligibility check");
    await c.query("commit");
    return "stored";
  } catch (e) {
    await c.query("rollback");
    if (observed) await c.query("update expiry_study_clock set floor_ms=greatest(floor_ms,$1) where id=1", [observed]);
    throw e;
  } finally {
    c.release();
  }
}
export async function sweepExpiryStudy() {
  enabled();
  const c = await pool.connect();
  try {
    await c.query("begin");
    const now = await clock(c);
    const r = await c.query("delete from expiry_study_claims where until_ms+$2<=$1", [now, STUDY_RECEIPT_GRACE_MS]);
    await c.query("commit");
    return r.rowCount;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

// Independent autocommit tick used by the isolated queue lifecycle before locking entries.
export async function studyServerNow() {
  enabled();
  return clock(pool);
}
// Read-only success reconciliation NEVER calls an ingestion callback or creates a claim.
export async function receiptExpiryStudy(token: string, org: number, sha: string) {
  enabled();
  const x = inspectExpiryLease(token);
  if (x.org !== org || x.sha !== sha) throw new ExpiryRefusal("identity mismatch");
  const now = await studyServerNow();
  if (now >= x.until + STUDY_RECEIPT_GRACE_MS) return false;
  const r = await pool.query("select 1 from expiry_study_claims where org=$1 and id=$2 and sha=$3 and until_ms=$4", [org, x.id, sha, x.until]);
  return r.rows.length === 1;
}
