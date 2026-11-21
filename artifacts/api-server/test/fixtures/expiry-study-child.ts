import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { bootstrapExpiryStudy, issueExpiryLease, acceptExpiryLease, sweepExpiryStudy } from "../../src/lib/expiryProtocolStudy";
await assert.rejects(() => bootstrapExpiryStudy(), /disabled/);
process.env.MONITORING_EXPIRY_PROTOCOL_TEST_ONLY = "yes";
process.env.MONITORING_EXPIRY_TEST_SECRET = "synthetic-isolated-expiry-study-secret";
await bootstrapExpiryStudy();
await pool.query("create table expiry_values(v int)");
const sha = createHash("sha256").update("immutable wire").digest("hex");
const write = async (c: any) => {
  await c.query("insert into expiry_values values(7)");
};
const count = async () => Number((await pool.query("select count(*) n from expiry_values")).rows[0].n);
const a = await issueExpiryLease(1, sha);
assert.equal(await acceptExpiryLease(a.token, 1, sha, write), "stored");
assert.equal(await acceptExpiryLease(a.token, 1, sha, write), "duplicate");
assert.equal(await count(), 1);
await assert.rejects(() => acceptExpiryLease(a.token, 2, sha, write), /identity/);
await assert.rejects(() => acceptExpiryLease(a.token, 1, "0".repeat(64), write), /identity/);
await assert.rejects(() => acceptExpiryLease(a.token + "x", 1, sha, write), /invalid/);
const realClientNow = Date.now;
Date.now = () => 0;
const legit = await issueExpiryLease(1, sha);
Date.now = realClientNow;
assert.notEqual(legit.lease.id, a.lease.id);
await acceptExpiryLease(legit.token, 1, sha, write);
assert.equal(await count(), 2);
const delayed = await issueExpiryLease(1, sha, 100);
await new Promise((r) => setTimeout(r, 120));
await assert.rejects(() => acceptExpiryLease(delayed.token, 1, sha, write), /expired at server admission/);
const inflight = await issueExpiryLease(1, sha, 100);
await assert.rejects(
  () =>
    acceptExpiryLease(inflight.token, 1, sha, async (c: any) => {
      await write(c);
      await c.query("select pg_sleep(0.15)");
    }),
  /expired before final eligibility/,
);
assert.equal(await count(), 2);
assert.equal(Number((await pool.query("select count(*) n from expiry_study_claims where id=$1", [inflight.lease.id])).rows[0].n), 0);
// Advance persisted SERVER high-water mark to model later observed time. This is not
// a claim that a test can change the operating system clock or physically suspend it.
await pool.query("update expiry_study_clock set floor_ms=$1 where id=1", [a.lease.until + 40000]);
assert.ok((await sweepExpiryStudy())! >= 2);
await pool.end();
// A fresh process will reuse the durable clock and find claims deleted. Token must
// still be refused. Fresh module/pool load is done by the parent in a second child.
console.log(
  "EXPIRY_RESULT " +
    JSON.stringify({ token: a.token, sha, stored: 2, delayedArrivalRejected: true, inflightRolledBack: true, defaultOff: true, claimCleanup: true }),
);
