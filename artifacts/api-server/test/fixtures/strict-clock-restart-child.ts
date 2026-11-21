// New process against SAME scratch database. No clock-floor reset allowed.
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { strictClock, strictReceipt, closeStrictClock } from "../../src/lib/strictMetricDelivery";
process.env.MONITORING_METRIC_DIRECT_TEST_ONLY = "yes";
process.env.MONITORING_METRIC_DIRECT_TEST_SECRET = "synthetic-direct-delivery-secret-for-local-test";
try {
  await assert.rejects(strictClock, /clock moved backward/);
  await assert.rejects(() => strictReceipt(1, process.env.CONTROL_LEASE!), /clock moved backward/);
  const floor = Number((await pool.query("select floor_ms from metric_direct_clock where id=1")).rows[0].floor_ms);
  await new Promise((r) => setTimeout(r, Math.max(0, floor - Date.now() + 30)));
  assert.ok((await strictClock()) >= floor);
  assert.equal((await strictReceipt(1, process.env.CONTROL_LEASE!)).state, "stored");
  console.log("CLOCK_RESTART_RESULT failClosedThenCatchupWithoutReset");
} finally {
  await closeStrictClock();
  await pool.end();
}
