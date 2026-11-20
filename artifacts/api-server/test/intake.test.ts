import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTraceId, tagValue } from "../src/intake/decode";
import { otlpToSpans, otlpToLogs, otlpToMetrics } from "../src/intake/otlp";

const s = (v: string) => ({ stringValue: v });
const resource = (extra: { key: string; value: unknown }[] = []) => ({
  attributes: [
    { key: "service.name", value: s("Checkout") },
    { key: "deployment.environment", value: s("prod") },
    { key: "host.name", value: s("web-1") },
    ...extra,
  ],
});

test("trace ids normalize to the low 64 bits in decimal", () => {
  assert.equal(normalizeTraceId("6af3a5a8000000005604429f91823c79"), BigInt("0x5604429f91823c79").toString());
  assert.equal(normalizeTraceId("12345"), "12345");
  assert.equal(normalizeTraceId(""), null);
  assert.equal(tagValue(["env:prod", "team:a"], "team"), "a");
});

test("OTLP spans map to services, resources, errors and durations", () => {
  const out = otlpToSpans({
    resourceSpans: [
      {
        resource: resource(),
        scopeSpans: [
          {
            scope: { name: "x" },
            spans: [
              {
                traceId: "6af3a5a8000000005604429f91823c79",
                spanId: "5604429f91823c79",
                name: "GET /checkout",
                kind: 2,
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "1250000000",
                status: { code: 2, message: "boom" },
                attributes: [{ key: "http.route", value: s("/checkout") }],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(out.length, 1);
  const sp = out[0] as any;
  assert.equal(sp.service, "Checkout"); // lowercased when stored (store.ts)
  assert.equal(sp.env, "prod");
  assert.equal(sp.host, "web-1");
  assert.equal(sp.duration, 250_000_000);
  assert.equal(sp.error, 1);
  assert.equal(sp.traceId, normalizeTraceId("6af3a5a8000000005604429f91823c79"));
});

test("OTLP logs keep severity, message and trace correlation", () => {
  const out = otlpToLogs({
    resourceLogs: [
      {
        resource: resource(),
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "2000000000",
                severityText: "ERROR",
                body: s("payment declined"),
                traceId: "5604429f91823c79",
              },
            ],
          },
        ],
      },
    ],
  });
  const l = out[0] as any;
  assert.equal(l.message, "payment declined");
  assert.equal(l.status, "error");
  assert.equal(l.service, "Checkout");
  assert.equal(l.traceId, normalizeTraceId("5604429f91823c79"));
});

test("OTLP metrics: tags and agent version from resource attributes", () => {
  for (const prefix of ["monitoring"]) {
    const { points, hosts } = otlpToMetrics(1, {
      resourceMetrics: [
        {
          resource: resource([
            { key: `${prefix}.tag.team`, value: s("pay") },
            { key: `${prefix}.agent.version`, value: s("1.2") },
          ]),
          scopeMetrics: [
            {
              scope: { name: "hostmetricsreceiver/load" },
              metrics: [{ name: "system.cpu.load_average.1m", gauge: { dataPoints: [{ timeUnixNano: "3000000000", asDouble: 1.5 }] } }],
            },
          ],
        },
      ],
    });
    assert.ok(points.length > 0, prefix);
    assert.ok(points[0].tags.includes("team:pay"), prefix);
    assert.ok(!points[0].tags.some((t) => t.includes("agent.version")), prefix);
    assert.equal(hosts.get("web-1")?.agentVersion, "1.2", prefix);
  }
});

test("log messages: terminal color codes are removed", async () => {
  const { stripAnsi } = await import("../src/intake/decode");
  assert.equal(stripAnsi('127.0.0.1 "\x1b[33mGET /products HTTP/1.1\x1b[0m" 200'), '127.0.0.1 "GET /products HTTP/1.1" 200');
  assert.equal(stripAnsi("plain message"), "plain message");
});
