"use strict";
// Private TEST-only metrics adapter. No stock metric transport, retries or spool.
const http = require("node:http");
const https = require("node:https");
const { createHash, randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { ProtobufMetricsSerializer } = require("@opentelemetry/otlp-transformer");
const { AggregationType } = require("@opentelemetry/sdk-metrics");
const { population, selectAggregationTemporality } = require("./normal-metric-population");
const PREFIX = "/otlp/candidate/node-app/v1";
const PROTOCOL = "monitoring-node-app-service-test-v1";
const CONTRACT = "node-app-representation-v2-candidate";
const LIMITS = Object.freeze({
  bytes: 1048576,
  fields: 100000,
  depth: 16,
  messages: 10000,
  resources: 64,
  scopes: 256,
  metrics: 1024,
  sourcePoints: 1000,
  derivedRowsUpperBound: 8000,
  bucketsPerPoint: 2048,
  buckets: 16384,
  kvPerSet: 64,
  kv: 4096,
  attributeDepth: 8,
  attributeBytes: 262144,
  stringBytes: 4096,
  nameBytes: 256,
  schemaBytes: 2048,
});
const PROFILE = Object.freeze({
  admissionMs: 30000,
  receiptGraceMs: 30000,
  dataCalls: 2,
  controlCalls: 4,
  bufferedBytes: 2097152,
  bodyMs: 1000,
  controlBytes: 1024,
  activeLeases: 20,
  issuesPerMinute: 10,
  cleanupBatch: 10,
});
const CLIENT = Object.freeze({
  records: 10,
  bytes: 10485760,
  responseBytes: 65536,
  requestMs: 5000,
  memoryMs: 30000,
  dataAttempts: 3,
  receiptAttempts: 6,
  leaseAttempts: 2,
  safetyMs: 1000,
});
const ACCOUNTING = [
  "sourcePoints",
  "numberPoints",
  "explicitHistogramPoints",
  "exponentialHistogramPoints",
  "omittedEmptyHistogramPoints",
  "derivedRows",
  "absentSumHistogramPoints",
  "absentDistributionHistogramPoints",
  "cumulativeSnapshotPoints",
];
const SUPPORTED = ["delta-sum", "gauge", "delta-explicit-histogram", "delta-exponential-histogram", "nonmonotonic-cumulative-snapshot"];
const OMITTED = ["exemplars-refused", "unknown-fields-refused", "raw-buckets-not-retained", "absent-distribution-no-quantiles"];
const fail = () => {
  throw Error("Candidate response unavailable or incompatible");
};
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) => {
  if (!object(v) || Object.keys(v).sort().join(",") !== [...keys].sort().join(",")) fail();
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
function destination(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Error("Candidate requires explicit root origin");
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !["https:", "http:"].includes(u.protocol) ||
    (u.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(u.hostname))
  )
    throw Error("Candidate requires HTTPS root origin or literal loopback TEST origin");
  return u.origin;
}
function validateCapability(c) {
  exact(c, [
    "protocol",
    "testOnly",
    "profile",
    "storage",
    "rawSubset",
    "representation",
    "accountingVersion",
    "compression",
    "exactIssuingKeyOnly",
    "lastUsedAtAccounting",
    "localSpool",
    "receiptOnClockUnavailable",
    "limits",
    "perWorker",
    "durability",
    "supported",
    "omitted",
  ]);
  if (
    c.protocol !== PROTOCOL ||
    c.testOnly !== true ||
    c.profile !== "test-v1" ||
    c.storage !== "postgres" ||
    c.rawSubset !== "node-app-protobuf-subset-v1-candidate" ||
    c.representation !== CONTRACT ||
    c.accountingVersion !== 1 ||
    c.compression !== "none" ||
    c.exactIssuingKeyOnly !== true ||
    c.lastUsedAtAccounting !== false ||
    c.localSpool !== false ||
    c.receiptOnClockUnavailable !== "refuse-unavailable" ||
    c.durability !== "same-tx-synchronous-commit" ||
    !equal(c.supported, SUPPORTED) ||
    !equal(c.omitted, OMITTED)
  )
    fail();
  for (const [v, expected] of [
    [c.limits, LIMITS],
    [c.perWorker, PROFILE],
  ]) {
    exact(v, Object.keys(expected));
    for (const k of Object.keys(expected)) if (v[k] !== expected[k]) fail();
  }
  return c;
}
function validateStored(v, r) {
  exact(v, ["state", "protocol", "id", "sha", "bytes", "accounting", "durability"]);
  if (
    v.state !== "stored" ||
    v.protocol !== PROTOCOL ||
    v.id !== r.id ||
    v.sha !== r.sha ||
    v.bytes !== r.length ||
    v.durability !== "same-tx-synchronous-commit"
  )
    fail();
  const a = v.accounting;
  exact(a, ["contract", ...ACCOUNTING]);
  if (
    a.contract !== CONTRACT ||
    ACCOUNTING.some((k) => !integer(a[k])) ||
    a.sourcePoints > LIMITS.sourcePoints ||
    a.derivedRows > LIMITS.derivedRowsUpperBound ||
    a.sourcePoints !== a.numberPoints + a.explicitHistogramPoints + a.exponentialHistogramPoints ||
    a.cumulativeSnapshotPoints > a.numberPoints
  )
    fail();
  for (const k of Object.keys(r.population)) if (a[k] !== r.population[k]) fail();
  const h = a.explicitHistogramPoints + a.exponentialHistogramPoints;
  if (
    ["omittedEmptyHistogramPoints", "absentSumHistogramPoints", "absentDistributionHistogramPoints"].some((k) => a[k] > h) ||
    a.derivedRows < a.numberPoints ||
    a.derivedRows > a.numberPoints + 8 * (h - a.omittedEmptyHistogramPoints)
  )
    fail();
  return v;
}
// One invocation, one request. Never redirects or retries. Only allowlisted headers.
function request(origin, key, path, body, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(PREFIX + path, origin),
      transport = url.protocol === "https:" ? https : http;
    if (!["/capabilities", "/lease", "/metrics", "/receipt"].includes(path)) {
      reject(Error("Candidate transport unavailable"));
      return;
    }
    const bytes = path === "/metrics" ? body.bytes : body ? Buffer.from(JSON.stringify(body)) : undefined;
    const headers = {
      "DC-API-KEY": key,
      ...(bytes ? { "Content-Type": path === "/metrics" ? "application/x-protobuf" : "application/json", "Content-Length": bytes.length } : {}),
    };
    if (path === "/metrics") {
      headers["x-monitoring-batch-id"] = body.id;
      headers["x-monitoring-delivery-credential"] = body.credential;
    }
    let done = false;
    const finish = (e, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      e ? reject(Error("Candidate transport unavailable")) : resolve(result);
    };
    const req = transport.request(url, { method: bytes ? "POST" : "GET", headers, maxHeaderSize: 8192, agent: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.destroy();
        finish(Error("redirect"));
        return;
      }
      if (
        res.headers["content-encoding"] ||
        res.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
        res.headers["cache-control"] !== "no-store"
      ) {
        res.destroy();
        finish(Error("response"));
        return;
      }
      const chunks = [];
      let n = 0;
      res.on("data", (b) => {
        n += b.length;
        if (n > CLIENT.responseBytes) {
          res.destroy();
          finish(Error("limit"));
        } else chunks.push(b);
      });
      res.on("aborted", () => finish(Error("aborted")));
      res.on("error", () => finish(Error("response")));
      res.on("end", () => {
        try {
          finish(null, { status: res.statusCode, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) });
        } catch {
          finish(Error("JSON"));
        }
      });
    });
    req.maxHeadersCount = 64;
    const abort = () => {
      req.destroy();
      finish(Error("abort"));
    };
    const timer = setTimeout(abort, CLIENT.requestMs);
    req.on("error", () => finish(Error("request")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    if (bytes) req.end(bytes);
    else req.end();
  });
}
class CandidateAppExporter {
  #origin;
  #key;
  #records = new Map();
  #chain = Promise.resolve();
  #active;
  #stopped = false;
  #bytes = 0;
  #onChange;
  #clock;
  #send;
  #archived = { stored: 0, unknown: 0, lostMemory: 0 };
  constructor(origin, key, onChange, testing = {}) {
    this.#origin = destination(origin);
    if (typeof key !== "string" || !/^[a-fA-F0-9]{32,64}$/.test(key)) throw Error("Candidate requires explicit API key");
    this.#key = key;
    this.#onChange = onChange;
    this.#clock = testing.clock || (() => ({ mono: performance.now(), wall: Date.now() }));
    this.#send = testing.request || request;
  }
  selectAggregationTemporality(type) {
    return selectAggregationTemporality(type);
  }
  selectAggregation() {
    return { type: AggregationType.DEFAULT };
  }
  #elapsed(start) {
    const now = this.#clock(),
      m = now.mono - start.mono,
      w = now.wall - start.wall;
    return { ms: Math.max(m, w), unsafe: m < 0 || w < 0 || Math.abs(m - w) > 1000 };
  }
  #release(r) {
    if (r.body) {
      this.#bytes -= r.body.length;
      r.body = null;
    }
  }
  #expire() {
    for (const [id, r] of this.#records) {
      const age = this.#elapsed(r.start);
      if (age.unsafe) r.receiptOnly = true;
      if ((!r.id && age.ms >= CLIENT.memoryMs) || (r.leaseStart && this.#elapsed(r.leaseStart).ms >= PROFILE.admissionMs + PROFILE.receiptGraceMs)) {
        this.#release(r);
        this.#records.delete(id);
        if (r.state === "stored") this.#archived.stored++;
        else if (r.mayHaveLeft) this.#archived.unknown++;
        else this.#archived.lostMemory++;
      } else if (r.leaseStart && this.#elapsed(r.leaseStart).ms >= PROFILE.admissionMs - CLIENT.safetyMs) {
        r.receiptOnly = true;
        this.#release(r);
      }
    }
  }
  snapshot() {
    this.#expire();
    return [...this.#records.values()].map((r) => ({
      localId: r.localId,
      state: r.state,
      dataAttempts: r.dataAttempts,
      receiptAttempts: r.receiptAttempts,
      leaseAttempts: r.leaseAttempts,
      retainedBytes: r.body?.length || 0,
      localSpool: false,
      accounting: r.accounting ? { ...r.accounting } : undefined,
    }));
  }
  summary() {
    this.#expire();
    return {
      ...this.#archived,
      retainedRecords: this.#records.size,
      retainedBytes: this.#bytes,
      localSpool: false,
      scope: "Current process only, no durable custody",
    };
  }
  #publish() {
    try {
      this.#onChange?.(this.snapshot());
    } catch {}
  }
  #enqueue(fn) {
    this.#chain = this.#chain.then(fn, fn);
    return this.#chain;
  }
  export(metrics, callback) {
    let called = false;
    const done = (result) => {
      if (!called) {
        called = true;
        try {
          callback(result);
        } catch {
          /* consumer cannot retain adapter work */
        }
      }
    };
    if (this.#stopped) return done({ code: 1, error: Error("Candidate exporter stopped") });
    this.#expire();
    if (this.#records.size >= CLIENT.records) return done({ code: 1, error: Error("Candidate memory backpressure") });
    let body, p;
    try {
      p = population(metrics);
      body = Buffer.from(ProtobufMetricsSerializer.serializeRequest(metrics));
      if (body.length > LIMITS.bytes || this.#bytes + body.length > CLIENT.bytes) fail();
    } catch {
      return done({ code: 1, error: Error("Candidate representation or memory refusal") });
    }
    const r = {
      localId: randomUUID(),
      body,
      length: body.length,
      sha: createHash("sha256").update(body).digest("hex"),
      population: p,
      start: this.#clock(),
      state: "queued",
      dataAttempts: 0,
      receiptAttempts: 0,
      leaseAttempts: 0,
      mayHaveLeft: false,
      done,
    };
    this.#records.set(r.localId, r);
    this.#bytes += body.length;
    this.#enqueue(async () => {
      try {
        if (!this.#stopped && this.#records.has(r.localId)) await this.#attempt(r, false);
      } catch {
        r.state = "unconfirmed";
      } finally {
        done(r.state === "stored" ? { code: 0 } : { code: 1, error: Error("Candidate delivery not confirmed") });
        this.#publish();
      }
    });
  }
  async #call(path, body) {
    if (this.#stopped) throw Error("stopped");
    const controller = new AbortController();
    this.#active = controller;
    try {
      return await this.#send(this.#origin, this.#key, path, body, controller.signal);
    } finally {
      if (this.#active === controller) this.#active = null;
    }
  }
  #eligible(r) {
    if (!r.body || r.receiptOnly || !r.leaseStart) return false;
    const age = this.#elapsed(r.start);
    if (!r.mayHaveLeft && (age.unsafe || age.ms >= CLIENT.memoryMs)) {
      r.receiptOnly = true;
      this.#release(r);
      return false;
    }
    const t = this.#elapsed(r.leaseStart);
    if (t.unsafe) {
      r.receiptOnly = true;
      return false;
    }
    return t.ms < PROFILE.admissionMs - CLIENT.safetyMs;
  }
  async #receipt(r) {
    if (!r.id || r.receiptAttempts >= CLIENT.receiptAttempts || this.#elapsed(r.leaseStart).ms >= PROFILE.admissionMs + PROFILE.receiptGraceMs)
      return "unavailable";
    r.receiptAttempts++;
    try {
      const res = await this.#call("/receipt", { id: r.id, credential: r.credential });
      if (res.status !== 200) return "unavailable";
      if (res.body?.state === "stored") {
        validateStored(res.body, r);
        r.state = "stored";
        r.accounting = res.body.accounting;
        this.#release(r);
        return "stored";
      }
      exact(res.body, ["state", "id"]);
      if (res.body.id !== r.id || !["unconfirmed", "expired-unconfirmed", "unknown"].includes(res.body.state)) fail();
      r.state = res.body.state;
      if (res.body.state !== "unconfirmed") {
        r.receiptOnly = true;
        this.#release(r);
      }
      return res.body.state;
    } catch {
      r.state = "unconfirmed";
      return "unavailable";
    }
  }
  async #attempt(r, recovery) {
    this.#expire();
    if (this.#stopped || !this.#records.has(r.localId) || r.state === "stored") return;
    if (r.id) {
      const observed = await this.#receipt(r);
      if (observed === "stored" || observed === "unknown" || observed === "expired-unconfirmed") return;
      if (!recovery || observed !== "unconfirmed" || !this.#eligible(r)) return;
    } else if (this.#elapsed(r.start).ms >= CLIENT.memoryMs || !r.body) return;
    let cap;
    try {
      const res = await this.#call("/capabilities");
      if (res.status !== 200) fail();
      cap = validateCapability(res.body);
    } catch {
      r.state = r.mayHaveLeft ? "unconfirmed" : "blocked-unsent";
      return;
    }
    if (!r.id) {
      const age = this.#elapsed(r.start);
      if (age.unsafe || age.ms >= CLIENT.memoryMs) {
        r.state = "lost-memory";
        this.#release(r);
        return;
      }
      if (r.leaseAttempts >= CLIENT.leaseAttempts) return;
      r.leaseAttempts++;
      const start = this.#clock();
      try {
        const res = await this.#call("/lease", { sha: r.sha, bytes: r.length, contract: CONTRACT });
        if (res.status !== 200) fail();
        const l = res.body;
        exact(l, ["protocol", "id", "credential", "until", "receiptUntil", "sha", "bytes", "contract"]);
        if (
          l.protocol !== PROTOCOL ||
          typeof l.id !== "string" ||
          typeof l.credential !== "string" ||
          !/^[a-f0-9]{32}$/.test(l.id) ||
          !/^[a-f0-9]{64}$/.test(l.credential) ||
          l.sha !== r.sha ||
          l.bytes !== r.length ||
          l.contract !== CONTRACT ||
          !integer(l.until) ||
          !integer(l.receiptUntil) ||
          l.receiptUntil - l.until !== cap.perWorker.receiptGraceMs
        )
          fail();
        r.id = l.id;
        r.credential = l.credential;
        r.leaseStart = start;
      } catch {
        r.state = "blocked-unsent";
        return;
      }
    }
    if (!this.#eligible(r) || r.dataAttempts >= CLIENT.dataAttempts) {
      r.state = r.dataAttempts >= CLIENT.dataAttempts ? "unconfirmed" : "expired-unconfirmed";
      return;
    }
    r.dataAttempts++;
    r.mayHaveLeft = true;
    r.state = "sending"; // BEFORE request creation, never reset.
    try {
      const res = await this.#call("/metrics", { id: r.id, credential: r.credential, bytes: r.body });
      if (res.status === 200) {
        validateStored(res.body, r);
        r.state = "stored";
        r.accounting = res.body.accounting;
        this.#release(r);
        return;
      }
      r.state = "unconfirmed";
    } catch {
      r.state = "unconfirmed";
    }
    for (let i = 0; i < 2 && r.state !== "stored"; i++) {
      const observed = await this.#receipt(r);
      if (observed !== "unavailable") break;
    }
  }
  recover(localId) {
    if (this.#stopped) return Promise.reject(Error("Candidate exporter stopped"));
    this.#expire();
    const r = this.#records.get(String(localId));
    if (!r) return Promise.reject(Error("No retained candidate record"));
    if (r.recovering) return r.recovering;
    r.recovering = this.#enqueue(async () => {
      try {
        await this.#attempt(r, true);
      } finally {
        r.recovering = null;
        this.#publish();
      }
      return this.snapshot();
    });
    return r.recovering;
  }
  async forceFlush() {
    await this.#chain;
  }
  async shutdown() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#active?.abort();
    for (const r of this.#records.values()) {
      r.done({ code: 1, error: Error("Candidate stopped with memory-only custody") });
      if (r.state !== "stored") {
        r.state = r.mayHaveLeft ? "unconfirmed" : "lost-memory";
      }
      this.#release(r);
    }
    await this.#chain;
    this.#publish();
  }
}
module.exports = {
  CandidateAppExporter,
  selectAggregationTemporality,
  destination,
  validateCapability,
  validateStored,
  population,
  request,
  LIMITS,
  PROFILE,
  CLIENT,
  PROTOCOL,
  CONTRACT,
};
