import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveProblem } from "../src/query/problemStatus";

const NOW = 1_800_000_000_000;

test("no record: active, no workflow", () => {
  const e = effectiveProblem(null, NOW);
  assert.equal(e.section, "active");
  assert.equal(e.workflow, null);
  assert.equal(e.reopened, false);
});

test("acknowledged stays active with the badge", () => {
  const e = effectiveProblem({ status: "acknowledged", statusAt: NOW - 1000, updatedBy: "a@b.c" }, NOW);
  assert.equal(e.section, "active");
  assert.equal(e.workflow, "acknowledged");
  assert.equal(e.reopened, false);
});

test("resolved moves to the resolved section when nothing new happened", () => {
  const e = effectiveProblem({ status: "resolved", statusAt: NOW - 1000, updatedBy: "a@b.c" }, NOW - 2000);
  assert.equal(e.section, "resolved");
  assert.equal(e.reopened, false);
});

test("new occurrences after a resolution re-surface the problem as active + reopened", () => {
  const e = effectiveProblem({ status: "resolved", statusAt: NOW - 1000, updatedBy: "a@b.c" }, NOW);
  assert.equal(e.section, "active");
  assert.equal(e.reopened, true);
  assert.equal(e.workflow, "resolved"); // the human record is preserved, not silently reset
});

test("resolved with no further data at all (null activity) stays resolved", () => {
  const e = effectiveProblem({ status: "resolved", statusAt: NOW - 1000, updatedBy: "a@b.c" }, null);
  assert.equal(e.section, "resolved");
  assert.equal(e.reopened, false);
});

test("muted stays muted; new activity is flagged, never silently dropped", () => {
  const quiet = effectiveProblem({ status: "muted", statusAt: NOW - 1000, updatedBy: "a@b.c" }, NOW - 2000);
  assert.equal(quiet.section, "muted");
  assert.equal(quiet.newActivityAfterMute, false);
  const active = effectiveProblem({ status: "muted", statusAt: NOW - 1000, updatedBy: "a@b.c" }, NOW);
  assert.equal(active.section, "muted");
  assert.equal(active.newActivityAfterMute, true);
});

test("negative control: activity exactly at status time is not 'new'", () => {
  const e = effectiveProblem({ status: "resolved", statusAt: NOW, updatedBy: "a@b.c" }, NOW);
  assert.equal(e.section, "resolved");
  assert.equal(e.reopened, false);
});
