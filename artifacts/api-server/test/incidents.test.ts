import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIncidents, INCIDENT_SCAN_LIMIT } from "../src/query/incidents";
import { fingerprintFor, normalizeMessage } from "../src/query/errorGroups";

const NOW = 1_800_000_000_000; // ms

function groupFor(service: string, type: string, msg: string, over: Record<string, unknown> = {}) {
  return {
    fingerprint: fingerprintFor(service, type, normalizeMessage(msg)),
    service,
    envs: ["prod"],
    error_type: type,
    message_example: msg,
    first_seen: NOW - 10 * 60_000,
    last_seen: NOW - 60_000,
    count: 3,
    ...over,
  };
}

function errSpan(service: string, resource: string, type: string, msg: string, version = "") {
  return { service, name: "http.server.request", resource, env: "prod", meta: { "error.type": type, "error.message": msg, ...(version ? { version } : {}) } };
}

test("incident matches its own group's spans only, ranks endpoints, lists observed versions", () => {
  const g = groupFor("checkout", "ValueError", "bad checkout payload");
  const other = groupFor("checkout", "KeyError", "missing field 'id'");
  const spans = [
    errSpan("checkout", "POST /api/checkout", "ValueError", "bad checkout payload", "3.0.1"),
    errSpan("checkout", "POST /api/checkout", "ValueError", "bad checkout payload", "3.0.1"),
    errSpan("checkout", "GET /api/cart", "ValueError", "bad checkout payload", "3.0.1"),
    errSpan("checkout", "GET /health", "KeyError", "missing field 'id'"), // belongs to the other group
    errSpan("billing", "POST /pay", "ValueError", "bad checkout payload"), // different service: fingerprint includes service
  ];
  const [inc] = buildIncidents([g], spans, NOW, { scanTruncated: false });
  assert.equal(inc.coverage.matchedTotal, 3);
  assert.deepEqual(inc.topEndpoints[0], { name: "POST /api/checkout", count: 2 });
  assert.deepEqual(inc.topEndpoints[1], { name: "GET /api/cart", count: 1 });
  assert.deepEqual(inc.versionsObserved, ["3.0.1"]);
  assert.equal(inc.isNew, true); // first seen 10 min ago
  void other;
});

test("isNew is false for groups first seen over an hour ago", () => {
  const g = groupFor("checkout", "ValueError", "bad checkout payload", { first_seen: NOW - 2 * 3600_000 });
  const [inc] = buildIncidents([g], [], NOW, { scanTruncated: false });
  assert.equal(inc.isNew, false);
  assert.equal(inc.coverage.matchedTotal, 0);
  assert.deepEqual(inc.topEndpoints, []);
  assert.deepEqual(inc.versionsObserved, []);
});

test("negative control: an empty scan never fabricates endpoints, versions or matches", () => {
  const g = groupFor("checkout", "ValueError", "bad checkout payload");
  const [inc] = buildIncidents([g], [], NOW, { scanTruncated: true });
  assert.equal(inc.coverage.matchedTotal, 0);
  assert.equal(inc.coverage.groupCount, 3); // recorded occurrences still shown from the group row
  assert.equal(inc.coverage.scanTruncated, true);
  assert.equal(inc.coverage.windowDays, 1);
});

test("version list is capped and notes overflow", () => {
  const g = groupFor("checkout", "ValueError", "bad checkout payload");
  const spans = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map((v) => errSpan("checkout", "POST /api/checkout", "ValueError", "bad checkout payload", v));
  const [inc] = buildIncidents([g], spans, NOW, { scanTruncated: false });
  assert.equal(inc.versionsObserved.length, 4);
  assert.equal(inc.versionsObserved[3], "(+1 more)");
});

test("incidents sort by lastSeen descending", () => {
  const a = groupFor("svc-a", "TypeError", "boom a", { last_seen: NOW - 5000 });
  const b = groupFor("svc-b", "TypeError", "boom b", { last_seen: NOW - 1000 });
  const incs = buildIncidents([a, b], [], NOW, { scanTruncated: false });
  assert.deepEqual(incs.map((i) => i.service), ["svc-b", "svc-a"]);
});

assert.ok(INCIDENT_SCAN_LIMIT >= 100, "scan limit is a real bound, not a token value");
