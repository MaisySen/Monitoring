import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import {
  bootstrapExpiryStudy,
  issueExpiryLease,
  acceptExpiryLease,
  receiptExpiryStudy,
  sweepExpiryStudy,
  STUDY_RECEIPT_GRACE_MS,
} from "../../src/lib/expiryProtocolStudy";
import {
  bootstrapLifecycleStudy,
  enqueueLifecycleStudy,
  deliverLifecycleStudy,
  recoverLifecycleStudy,
  reconcileLifecycleStudy,
  statusLifecycleStudy,
  sweepLifecycleStudy,
} from "../../src/lib/expiryLifecycleStudy";
process.env.MONITORING_EXPIRY_PROTOCOL_TEST_ONLY = "yes";
process.env.MONITORING_EXPIRY_TEST_SECRET = "synthetic-isolated-expiry-study-secret";
await bootstrapExpiryStudy();
await bootstrapLifecycleStudy();
await pool.query("create table lifecycle_values(v int)");
const body = Buffer.from("7"),
  sha = createHash("sha256").update(body).digest("hex");
const large = Buffer.alloc(256, 1),
  largeSha = createHash("sha256").update(large).digest("hex");
for (let i = 0; i < 4; i++) {
  const l = await issueExpiryLease(3, largeSha);
  await enqueueLifecycleStudy(l.token, 3, large);
}
const tooManyBytes = await issueExpiryLease(3, largeSha);
await assert.rejects(() => enqueueLifecycleStudy(tooManyBytes.token, 3, large), /capacity/);
const tooLarge = Buffer.alloc(257),
  tooLargeSha = createHash("sha256").update(tooLarge).digest("hex");
const bigLease = await issueExpiryLease(3, tooLargeSha);
await assert.rejects(() => enqueueLifecycleStudy(bigLease.token, 3, tooLarge), /body limit/);
const exhausted = await issueExpiryLease(4, sha);
await enqueueLifecycleStudy(exhausted.token, 4, body);
for (let i = 0; i < 3; i++) {
  assert.equal(
    await deliverLifecycleStudy(4, exhausted.lease.id, async () => {
      throw Object.assign(Error(), { status: 401 });
    }),
    "blocked",
  );
  if (i < 2) assert.equal(await recoverLifecycleStudy(4, exhausted.lease.id, true), "pending");
}
assert.equal(await recoverLifecycleStudy(4, exhausted.lease.id, true), "not-recoverable");
assert.equal((await statusLifecycleStudy(4))[0].attempts, 3);
const lease = await issueExpiryLease(1, sha);
assert.equal(await enqueueLifecycleStudy(lease.token, 1, body), "pending");
let attempts = 0;
assert.equal(
  await deliverLifecycleStudy(1, lease.lease.id, async () => {
    attempts++;
    throw Object.assign(Error(), { status: 401 });
  }),
  "blocked",
);
let rows = await statusLifecycleStudy(1);
assert.equal(rows[0].retained_bytes, 1);
assert.equal(rows[0].reason, "backend authorization refused");
assert.equal(
  await deliverLifecycleStudy(1, lease.lease.id, async () => {
    attempts++;
  }),
  "blocked",
);
assert.equal(attempts, 1, "restored backend alone must not replay blocked data");
await assert.rejects(() => recoverLifecycleStudy(1, lease.lease.id, false), /approval/);
assert.equal(await recoverLifecycleStudy(2, lease.lease.id, true), "not-recoverable");
assert.equal(await recoverLifecycleStudy(1, lease.lease.id, true), "pending");
const write = async (c: any) => {
  await c.query("insert into lifecycle_values values(7)");
};
assert.equal(
  await deliverLifecycleStudy(1, lease.lease.id, async (t, b) => {
    await acceptExpiryLease(t, 1, createHash("sha256").update(b).digest("hex"), write);
    throw Error("lost ACK after commit");
  }),
  "blocked",
);
assert.equal(Number((await pool.query("select count(*) n from lifecycle_values")).rows[0].n), 1);
// Model persisted later server time, not OS clock/suspend or timing proof.
await pool.query("update expiry_study_clock set floor_ms=$1 where id=1", [lease.lease.until + 1]);
assert.equal(await recoverLifecycleStudy(1, lease.lease.id, true), "not-recoverable");
assert.equal(await reconcileLifecycleStudy(1, lease.lease.id, (t, s) => receiptExpiryStudy(t, 1, s)), "acked");
assert.equal(await enqueueLifecycleStudy(lease.token, 1, body), "acked", "durable successful ACK replay after send expiry");
assert.equal(await acceptExpiryLease(lease.token, 1, sha, write), "duplicate", "server success receipt after expiry must never re-execute");
const restarted = execFileSync(process.execPath, ["--import", "tsx", "test/fixtures/expiry-lifecycle-restart.ts"], {
  encoding: "utf8",
  env: { ...process.env, STUDY_TOKEN: lease.token, STUDY_SHA: sha },
  timeout: 30000,
});
assert.match(restarted, /LIFECYCLE_RESTART_ACK_OK/);
rows = await statusLifecycleStudy(1);
assert.equal(rows[0].retained_bytes, 0);
assert.equal(rows[0].attempts, 2);
await assert.rejects(() => enqueueLifecycleStudy(lease.token, 2, body), /identity/);
// Fill capacity with ACK receipts, not pending bytes, then prove bounded time cleanup restores admission.
for (let i = 0; i < 15; i++) {
  const l = await issueExpiryLease(1, sha);
  await enqueueLifecycleStudy(l.token, 1, body);
  await deliverLifecycleStudy(1, l.lease.id, async (t) => {
    await acceptExpiryLease(t, 1, sha, write);
  });
}
const overflow = await issueExpiryLease(1, sha);
await assert.rejects(() => enqueueLifecycleStudy(overflow.token, 1, body), /capacity/);
await pool.query("update expiry_study_clock set floor_ms=$1 where id=1", [overflow.lease.until + STUDY_RECEIPT_GRACE_MS + 1]);
assert.equal(await sweepLifecycleStudy(), 21);
assert.ok((await sweepExpiryStudy())! >= 16);
assert.equal(await receiptExpiryStudy(lease.token, 1, sha), false);
await assert.rejects(() => enqueueLifecycleStudy(lease.token, 1, body), /expired/);
await assert.rejects(() => acceptExpiryLease(lease.token, 1, sha, write), /expired/);
const fresh = await issueExpiryLease(1, sha);
assert.equal(await enqueueLifecycleStudy(fresh.token, 1, body), "pending");
console.log(
  "LIFECYCLE_RESULT " +
    JSON.stringify({
      blocked401Retained: true,
      explicitRecoveryMaxAttempts: 3,
      pendingBytesBounded: true,
      bodySizeBounded: true,
      noImplicitRetry: true,
      explicitBoundedRecovery: true,
      lostAckReconciledAfterExpiry: true,
      ackedReplay: "acked",
      bytesReclaimed: true,
      receiptCapacity: 16,
      cleanupRestoresAdmission: true,
      oldTokenCannotReinsert: true,
      stored: 16,
      freshId: fresh.lease.id,
    }),
);
await pool.end();
