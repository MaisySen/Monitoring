import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateErrorGroups, fingerprintFor, normalizeMessage } from "../src/query/errorGroups";

const span = (over: Partial<Parameters<typeof aggregateErrorGroups>[0][number]>) => ({
  service: "billing",
  env: "prod",
  error: 1,
  start: 1_700_000_000_000_000_000,
  meta: {},
  ...over,
});

test("normalizeMessage collapses occurrence-varying fragments", () => {
  assert.equal(
    normalizeMessage("user 42 not found"),
    normalizeMessage("user 43 not found"),
  );
  assert.equal(
    normalizeMessage("order 9f8e7d6c-1234-4abc-9def-0123456789ab failed at 2026-11-21T06:00:00Z from 10.0.0.7"),
    normalizeMessage("order 11111111-2222-3333-4444-555555555555 failed at 2026-11-21T07:30:00Z from 192.168.1.20"),
  );
  assert.equal(normalizeMessage("  multiple   spaces\t\nkept "), "multiple spaces kept");
});

test("fingerprint is stable and separates distinct shapes", () => {
  const a = fingerprintFor("billing", "TypeError", normalizeMessage("user 42 not found"));
  assert.equal(a, fingerprintFor("billing", "TypeError", normalizeMessage("user 43 not found")));
  assert.notEqual(a, fingerprintFor("billing", "TypeError", normalizeMessage("payment declined")));
  assert.notEqual(a, fingerprintFor("billing", "KeyError", normalizeMessage("user 42 not found")));
  assert.notEqual(a, fingerprintFor("frontend", "TypeError", normalizeMessage("user 42 not found")));
});

test("aggregateErrorGroups groups recurring errors and keeps counts and time bounds", () => {
  const base = 1_700_000_000_000_000_000;
  const spans = [
    span({ start: base, meta: { "error.type": "TypeError", "error.message": "user 42 not found" } }),
    span({ start: base + 60_000_000_000, meta: { "error.type": "TypeError", "error.message": "user 43 not found" } }),
    span({ start: base + 30_000_000_000, meta: { "error.type": "KeyError", "error.message": "missing field 'id'" } }),
    span({ error: 0, meta: {} }), // non-error spans never group
  ];
  const groups = aggregateErrorGroups(spans);
  assert.equal(groups.length, 2);
  const typeErr = groups.find((g) => g.errorType === "TypeError")!;
  assert.equal(typeErr.count, 2);
  assert.equal(typeErr.firstSeenMs, Math.floor(base / 1e6));
  assert.equal(typeErr.lastSeenMs, Math.floor((base + 60_000_000_000) / 1e6));
  assert.equal(typeErr.messageExample, "user 42 not found"); // first raw message kept
  const keyErr = groups.find((g) => g.errorType === "KeyError")!;
  assert.equal(keyErr.count, 1);
});

test("errors without type/message still group generically per service", () => {
  const groups = aggregateErrorGroups([span({}), span({}), span({ service: "frontend" })]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.service === "billing")!.count, 2);
  assert.equal(groups.find((g) => g.service === "billing")!.messageExample, "(no error.message)");
});

test("message example is truncated and fingerprint separates messages only by shape", () => {
  const long = "x".repeat(1000) + " 42";
  const groups = aggregateErrorGroups([span({ meta: { "error.type": "E", "error.message": long } })]);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].messageExample.length <= 500);
});
