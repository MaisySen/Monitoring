"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AgentMetricCustody } = require("../lib/agent-metric-custody");
const { config } = require("../config");
test("custody explicit selector never silently replaces default or direct path", () => {
  const normal = config({}, {});
  assert.equal(normal.metricCustodyTest, false);
  assert.throws(() => config({}, { MONITORING_METRIC_CUSTODY_TEST_ONLY: "yes" }), /custody/);
  assert.throws(
    () =>
      config(
        {},
        {
          MONITORING_METRIC_CUSTODY_TEST_ONLY: "yes",
          MONITORING_METRIC_CUSTODY_URL: "http://127.0.0.1:4438",
          MONITORING_API_KEY: "test",
          MONITORING_METRICS_RETRY: "true",
        },
      ),
    /custody/,
  );
});
test("agent custody is not backend stored, survives exporter shutdown without false loss", async () => {
  const e = new AgentMetricCustody("http://unused", {});
  e.publish = () => {};
  const r = { localId: "x", id: "same", epoch: "original", token: "same", state: "blocked", body: Buffer.from("7"), born: Date.now(), attempts: 1 };
  e.records.set("x", r);
  e.request = async (path) => ({
    ok: true,
    json: async () => ({
      id: "same",
      epoch: "original",
      custody: true,
      backendStored: false,
      state: "blocked",
      reason: "durable agent only",
      retainUntil: Date.now() + 300000,
      backendId: "backend-same",
    }),
  });
  await e.receipt(r);
  assert.equal(r.state, "custody");
  assert.equal(r.body, null);
  assert.equal(e.snapshot()[0].backendStored, false);
  await e.shutdown();
  assert.equal(r.state, "custody");
});
test("new journal epoch or unknown receipt never creates replacement input identity", async () => {
  const e = new AgentMetricCustody("http://unused", {});
  e.publish = () => {};
  const r = { localId: "x", id: "same", epoch: "original", token: "same", state: "blocked", body: Buffer.from("7"), born: Date.now(), attempts: 1 };
  e.records.set("x", r);
  let paths = [];
  e.request = async (path) => {
    paths.push(path);
    return { status: 409, ok: false };
  };
  await e.recover("x");
  assert.equal(r.state, "unknown");
  assert.equal(r.body, null);
  assert.deepEqual(paths, ["/receipt"]);
});
