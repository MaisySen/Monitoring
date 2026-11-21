// Fresh worker/pool, same durable queue and server success receipt, after send expiry.
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { acceptExpiryLease } from "../../src/lib/expiryProtocolStudy";
import { enqueueLifecycleStudy, statusLifecycleStudy } from "../../src/lib/expiryLifecycleStudy";
assert.equal(await enqueueLifecycleStudy(process.env.STUDY_TOKEN!, 1, Buffer.from("7")), "acked");
assert.equal(
  await acceptExpiryLease(process.env.STUDY_TOKEN!, 1, process.env.STUDY_SHA!, async () => {
    throw Error("duplicate must not write");
  }),
  "duplicate",
);
const status = await statusLifecycleStudy(1);
assert.equal(status.length, 1);
assert.equal(status[0].state, "acked");
assert.equal(status[0].retained_bytes, 0);
assert.equal(Number((await pool.query("select count(*) n from lifecycle_values")).rows[0].n), 1);
await pool.end();
console.log("LIFECYCLE_RESTART_ACK_OK");
