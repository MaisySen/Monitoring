// Sends explicitly named verification telemetry to a running local Monitoring Agent.
// No API key is needed: the agent authenticates its outbound connection.
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import dgram from "node:dgram";

const traceId = randomBytes(16).toString("hex");
const spanId = randomBytes(8).toString("hex");
const start = BigInt(Date.now()) * 1_000_000n;
const service = "monitoring-agent-smoke";
const response = await fetch("http://127.0.0.1:4318/v1/traces", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeSpans: [{
        scope: { name: "monitoring-agent-verification", version: "0.1.0" },
        spans: [{
          traceId, spanId, name: "GET /agent-smoke", kind: 2,
          startTimeUnixNano: start.toString(),
          endTimeUnixNano: (start + 5_000_000n).toString(),
          attributes: [{ key: "http.request.method", value: { stringValue: "GET" } },
            { key: "http.route", value: { stringValue: "/agent-smoke" } }],
          status: { code: 1 },
        }],
      }],
    }],
  }),
});
if (!response.ok) throw new Error(`OTLP input: ${response.status} ${await response.text()}`);

// Minimal MessagePack writer for the migration trace protocol (uint64 IDs included).
function pack(v) {
  if (typeof v === "bigint" || typeof v === "number") {
    const out = Buffer.alloc(9);
    out[0] = 0xcf;
    out.writeBigUInt64BE(BigInt(v), 1);
    return out;
  }
  if (typeof v === "string") {
    const s = Buffer.from(v);
    const h = s.length < 32 ? Buffer.from([0xa0 | s.length]) : Buffer.from([0xd9, s.length]);
    return Buffer.concat([h, s]);
  }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from([0x90 | v.length]), ...v.map(pack)]);
  const pairs = Object.entries(v);
  return Buffer.concat([Buffer.from([0x80 | pairs.length]), ...pairs.flatMap(([k, value]) => [pack(k), pack(value)])]);
}
const legacyTrace = randomBytes(16).toString("hex");
const legacySpan = randomBytes(8).toString("hex");
const compat = await fetch("http://127.0.0.1:8126/v0.4/traces", {
  method: "POST",
  headers: { "Content-Type": "application/msgpack", "X-Datadog-Trace-Count": "1" },
  body: pack([[{
    service: "monitoring-agent-compat-smoke", name: "web.request", resource: "GET /compat-smoke",
    type: "web", trace_id: BigInt(`0x${legacyTrace.slice(16)}`), span_id: BigInt(`0x${legacySpan}`),
    parent_id: 0n, start, duration: 5_000_000n, error: 0,
    meta: { env: "agent-qa", "_dd.p.tid": legacyTrace.slice(0, 16), "http.method": "GET" },
    metrics: { "_top_level": 1 },
  }]]),
});
if (!compat.ok) throw new Error(`migration input: ${compat.status} ${await compat.text()}`);

const udp = dgram.createSocket("udp4");
await new Promise((resolve, reject) => udp.send(
  Buffer.from("monitoring.agent.smoke.requests:3|c|#service:monitoring-agent-smoke,verification:monitoring-agent\n" +
    "monitoring.agent.smoke.temperature:42|g|#verification:monitoring-agent\n" +
    "monitoring.agent.smoke.latency:12|ms|#verification:monitoring-agent"),
  8125, "127.0.0.1", (err) => err ? reject(err) : resolve(),
));
udp.close();
if (process.env.SMOKE_LOG_PATH) {
  appendFileSync(process.env.SMOKE_LOG_PATH, JSON.stringify({
    timestamp: new Date().toISOString(), level: "info",
    message: "Monitoring Agent end-to-end verification", trace_id: traceId, span_id: spanId,
  }) + "\n");
}
const evidence = { otlp_status: response.status, migration_status: compat.status, trace_id: traceId,
  span_id: spanId, migration_trace_id: legacyTrace, migration_span_id: legacySpan };
if (process.env.SMOKE_EVIDENCE_PATH) writeFileSync(process.env.SMOKE_EVIDENCE_PATH, JSON.stringify(evidence));
console.log(JSON.stringify(evidence));
