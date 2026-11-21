"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DirectMetricDelivery } = require("../lib/direct-metric-delivery");
test("ambiguous identity after grace never reacquires lease or sends data; reports process-local unknown", async () => {
  const e = new DirectMetricDelivery("http://unused", {});
  let sent = 0;
  e.request = async (path) => {
    sent++;
    assert.equal(path, "/receipt");
    return { ok: true, json: async () => ({ state: "unknown" }) };
  };
  e.publish = () => {};
  const r = {
    localId: "x",
    token: "same-original-token",
    id: "original",
    state: "blocked",
    attempts: 1,
    until: Date.now() - 40000,
    receiptUntil: Date.now() - 10000,
    body: Buffer.from("old delta"),
    born: Date.now() - 70000,
  };
  e.records.set("x", r);
  await e.recover("x");
  assert.equal(r.state, "unknown");
  assert.equal(sent, 1);
  assert.equal(e.summary().unknownBatches, 1);
  assert.equal(e.summary().retainedRecords, 0);
  assert.equal(e.summary().unknownBatches, 1);
});
test("no-token network failure drops unsent bytes within finite window and frees bounded capacity", () => {
  const e = new DirectMetricDelivery("http://unused", {});
  const r = { localId: "x", state: "blocked", attempts: 1, body: Buffer.from("unsent"), born: Date.now() - 31000 };
  e.records.set("x", r);
  assert.equal(e.snapshot()[0].state, "lost");
  assert.equal(r.body, null);
  r.born = Date.now() - 61000;
  assert.equal(e.snapshot().length, 0);
  assert.equal(e.summary().lostBatches, 1);
});
test("unsupported backend response cannot fall back or send data", async () => {
  const e = new DirectMetricDelivery("http://unused", {});
  let paths = [];
  e.publish = () => {};
  e.request = async (path) => {
    paths.push(path);
    return { ok: false };
  };
  const r = { localId: "x", state: "collecting", attempts: 0, body: Buffer.from("delta"), born: Date.now() };
  await e.attempt(r);
  assert.deepEqual(paths, ["/capabilities"]);
  assert.equal(r.state, "blocked");
  assert.equal(r.token, undefined);
});
