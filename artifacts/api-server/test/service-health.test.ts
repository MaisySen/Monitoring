import { test } from "node:test";
import assert from "node:assert/strict";
import { computeServiceHealth } from "../src/query/serviceHealth";

const NOW = 1_800_000_000;
const row = (over: Partial<Parameters<typeof computeServiceHealth>[0][number]>) => ({
  service: "svc",
  last_bucket: NOW - 60,
  ops5: 0,
  err_ops5: 0,
  ops_prev: 0,
  err_ops_prev: 0,
  ...over,
});

test("low traffic with observed errors shows the errors alongside the uncertainty", () => {
  const [h] = computeServiceHealth([row({ ops5: 10, err_ops5: 10 })], NOW);
  assert.equal(h.state, "low");
  assert.match(h.note, /10 errors in 10 operations/);
  assert.match(h.note, /too little traffic/);
});

test("low traffic without errors does not invent errors", () => {
  const [h] = computeServiceHealth([row({ ops5: 10, err_ops5: 0 })], NOW);
  assert.equal(h.state, "low");
  assert.doesNotMatch(h.note, /error/);
});

test("quiet is reported as unknowable, never as failure or health", () => {
  const [h] = computeServiceHealth([row({ last_bucket: NOW - 15 * 60 })], NOW);
  assert.equal(h.state, "quiet");
  assert.match(h.note, /not proof of failure/);
});

test("degraded requires enough traffic, an error rate, and volume or baseline lift", () => {
  const [h] = computeServiceHealth([row({ ops5: 100, err_ops5: 5 })], NOW);
  assert.equal(h.state, "degraded");
  assert.match(h.note, /5 errors in 100 operations \(5\.0%\)/);
});

test("errors below the degraded threshold still show counts", () => {
  const [h] = computeServiceHealth([row({ ops5: 100, err_ops5: 1 })], NOW);
  assert.equal(h.state, "ok");
  assert.match(h.note, /1 errors in 100 operations/);
  assert.doesNotMatch(h.note, /No errors observed/);
});
