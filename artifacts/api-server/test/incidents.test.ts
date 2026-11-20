import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIncidents, deployEvidenceFor, INCIDENT_SCAN_LIMIT } from "../src/query/incidents";
import { aggregateServiceVersions, fingerprintFor, normalizeMessage } from "../src/query/errorGroups";

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

// ---------- Deploy evidence rule ----------
// The rule may claim "first observed after deploy V" only when observation coverage is
// complete AND a service_versions row strictly predates the group's first sighting.

function deployMap(service: string, version: string, firstSeen: number) {
  return new Map([[service, new Map([[version, firstSeen]])]]);
}

function deployIncident(over: Record<string, unknown> = {}) {
  return {
    service: "checkout",
    firstSeen: NOW - 10 * 60_000,
    matchedVersionsDistinct: 1,
    matchedSingleVersion: "3.0.2",
    matchedUntagged: 0,
    coverage: { matchedTotal: 3, groupCount: 3, scanned: 5, scanTruncated: false, windowDays: 1 },
    ...over,
  } as any;
}

test("deploy evidence: all gates pass -> timing claim with the deploy's first_seen", () => {
  const ev = deployEvidenceFor(deployIncident(), deployMap("checkout", "3.0.2", NOW - 20 * 60_000));
  assert.deepEqual(ev, { version: "3.0.2", deployFirstSeen: NOW - 20 * 60_000 });
});

test("negative control: truncated scan forbids the claim", () => {
  const inc = deployIncident({ coverage: { matchedTotal: 3, groupCount: 3, scanned: 2000, scanTruncated: true, windowDays: 1 } });
  assert.equal(deployEvidenceFor(inc, deployMap("checkout", "3.0.2", NOW - 20 * 60_000)), null);
});

test("negative control: one untagged matched span forbids the claim", () => {
  const inc = deployIncident({ matchedUntagged: 1, coverage: { matchedTotal: 4, groupCount: 4, scanned: 5, scanTruncated: false, windowDays: 1 } });
  assert.equal(deployEvidenceFor(inc, deployMap("checkout", "3.0.2", NOW - 20 * 60_000)), null);
});

test("negative control: two observed versions forbid the claim", () => {
  const inc = deployIncident({ matchedVersionsDistinct: 2, matchedSingleVersion: null });
  assert.equal(deployEvidenceFor(inc, deployMap("checkout", "3.0.2", NOW - 20 * 60_000)), null);
});

test("negative control: no matched spans forbid the claim", () => {
  const inc = deployIncident({ matchedVersionsDistinct: 0, matchedSingleVersion: null, coverage: { matchedTotal: 0, groupCount: 3, scanned: 0, scanTruncated: false, windowDays: 1 } });
  assert.equal(deployEvidenceFor(inc, deployMap("checkout", "3.0.2", NOW - 20 * 60_000)), null);
});

test("negative control: missing deploy record forbids the claim", () => {
  assert.equal(deployEvidenceFor(deployIncident(), new Map()), null);
  assert.equal(deployEvidenceFor(deployIncident(), deployMap("other-service", "3.0.2", NOW - 20 * 60_000)), null);
});

test("negative control: deploy first_seen at or after the group's first sighting cannot be ordered, no claim", () => {
  assert.equal(deployEvidenceFor(deployIncident(), deployMap("checkout", "3.0.2", NOW - 10 * 60_000)), null); // equal
  assert.equal(deployEvidenceFor(deployIncident(), deployMap("checkout", "3.0.2", NOW - 5 * 60_000)), null); // after
});

test("buildIncidents exposes the uncapped observation state the rule consumes", () => {
  const g = groupFor("checkout", "ValueError", "bad checkout payload");
  const spans = [
    errSpan("checkout", "POST /c", "ValueError", "bad checkout payload", "3.0.2"),
    errSpan("checkout", "POST /c", "ValueError", "bad checkout payload", "3.0.2"),
  ];
  const [inc] = buildIncidents([g], spans, NOW, { scanTruncated: false });
  assert.equal(inc.matchedVersionsDistinct, 1);
  assert.equal(inc.matchedSingleVersion, "3.0.2");
  assert.equal(inc.matchedUntagged, 0);
  assert.equal(inc.deployEvidence, null); // set only by computeExceptionIncidents via the rule
  const [inc2] = buildIncidents([g], [...spans, errSpan("checkout", "POST /c", "ValueError", "bad checkout payload")], NOW, { scanTruncated: false });
  assert.equal(inc2.matchedUntagged, 1);
});

test("aggregateServiceVersions: first/last per (service, version), untagged spans skipped", () => {
  const rows = aggregateServiceVersions([
    { service: "checkout", env: "prod", error: 0, start: 1_000_000_000, meta: { version: "3.0.2" } }, // 1000 ms
    { service: "checkout", env: "prod", error: 0, start: 3_000_000_000, meta: { version: "3.0.2" } }, // 3000 ms
    { service: "checkout", env: "prod", error: 0, start: 2_000_000_000, meta: { version: "3.0.1" } },
    { service: "billing", env: "prod", error: 0, start: 5_000_000_000, meta: { version: "3.0.2" } },
    { service: "checkout", env: "prod", error: 0, start: 9_000_000_000, meta: {} }, // untagged: never creates a row
  ] as any);
  assert.equal(rows.length, 3);
  const c302 = rows.find((r) => r.service === "checkout" && r.version === "3.0.2")!;
  assert.equal(c302.firstMs, 1000);
  assert.equal(c302.lastMs, 3000);
  assert.ok(rows.some((r) => r.service === "billing" && r.version === "3.0.2"));
  assert.ok(!rows.some((r) => r.firstMs === 9000)); // untagged span left no trace
});
