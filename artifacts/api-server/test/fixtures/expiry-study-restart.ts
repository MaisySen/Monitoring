import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { acceptExpiryLease, bootstrapExpiryStudy } from "../../src/lib/expiryProtocolStudy";
process.env.MONITORING_EXPIRY_PROTOCOL_TEST_ONLY = "yes";
process.env.MONITORING_EXPIRY_TEST_SECRET = "synthetic-isolated-expiry-study-secret";
await bootstrapExpiryStudy();
await assert.rejects(
  () =>
    acceptExpiryLease(process.env.STUDY_TOKEN!, 1, process.env.STUDY_SHA!, async (c: any) => {
      await c.query("insert into expiry_values values(99)");
    }),
  /expired/,
);
assert.equal(Number((await pool.query("select count(*) n from expiry_values")).rows[0].n), 2);
await pool.end();
console.log("restart-cleanup-old-token-refused");
