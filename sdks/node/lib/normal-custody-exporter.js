"use strict";
// TEST-ONLY memory-before-ACK exporter. It is not candidate-direct, has no SDK
// disk spool and never turns a missing/invalid custody ACK into DATA replay.
const { createHash, randomUUID } = require("node:crypto"),
  { performance } = require("node:perf_hooks");
const { ProtobufMetricsSerializer } = require("@opentelemetry/otlp-transformer");
const { AggregationType } = require("@opentelemetry/sdk-metrics");
const { population, selectAggregationTemporality } = require("./normal-metric-population");
const wire = require("./normal-custody-wire"),
  { request } = require("./normal-custody-transport");
const LIMITS = Object.freeze({ records: 10, bytes: 10485760, inputBytes: 1048576, memoryMs: 30000, sendMs: 29000, retentionMs: 330000, receipts: 6 });
class NormalCustodyExporter {
  #origin;
  #key;
  #clock;
  #send;
  #change;
  #records = new Map();
  #bytes = 0;
  #chain = Promise.resolve();
  #active;
  #stopped = false;
  #shutdown;
  #pending = 0;
  #archived = { backendStored: 0, custodyObserved: 0, unconfirmed: 0, unsent: 0 };
  constructor(origin, key, onChange, testing = {}) {
    this.#origin = wire.destination(origin);
    if (typeof key !== "string" || !/^[a-fA-F0-9]{32,64}$/.test(key)) wire.fail();
    this.#key = key;
    this.#clock = testing.clock || (() => ({ mono: performance.now(), wall: Date.now() }));
    this.#send = testing.request || request;
    this.#change = onChange;
  }
  selectAggregationTemporality(type) {
    return selectAggregationTemporality(type);
  }
  selectAggregation() {
    return { type: AggregationType.DEFAULT };
  }
  #age(start) {
    const n = this.#clock(),
      m = n.mono - start.mono,
      w = n.wall - start.wall;
    return { ms: Math.max(m, w), unsafe: ![n.mono, n.wall, start.mono, start.wall].every(Number.isFinite) || m < 0 || w < 0 || Math.abs(m - w) > 100 };
  }
  #release(r) {
    if (r.body) {
      this.#bytes -= r.body.length;
      r.body = null;
    }
  }
  #expire() {
    for (const [id, r] of this.#records) {
      const a = this.#age(r.start),
        l = r.leaseStart && this.#age(r.leaseStart);
      if (a.unsafe || l?.unsafe) r.receiptOnly = true;
      if ((!r.id && (a.unsafe || a.ms >= LIMITS.memoryMs)) || (l && (l.unsafe || l.ms >= LIMITS.sendMs))) {
        r.receiptOnly = true;
        this.#release(r);
      }
      if ((!r.id && (a.unsafe || a.ms >= LIMITS.memoryMs)) || (l && l.ms >= LIMITS.retentionMs)) {
        this.#release(r);
        this.#records.delete(id);
        this.#archived[r.backendStored ? "backendStored" : r.acknowledged ? "custodyObserved" : r.mayHaveLeft ? "unconfirmed" : "unsent"]++;
      }
    }
  }
  snapshot() {
    this.#expire();
    return [...this.#records.values()].map((r) => ({
      localId: r.localId,
      id: r.id || null,
      epoch: r.epoch || null,
      state: r.state,
      custodyObserved: r.custodyObserved,
      backendStored: r.backendStored,
      acknowledged: r.acknowledged,
      observationOnly: true,
      observedAt: r.observedAt || null,
      receiptOnly: !!r.receiptOnly || r.mayHaveLeft,
      retainedBytes: r.body?.length || 0,
      leaseAttempts: r.leaseAttempts,
      dataAttempts: r.dataAttempts,
      receiptAttempts: r.receiptAttempts,
      sdkLocalSpool: false,
      accounting: r.accounting ? { ...r.accounting } : null,
    }));
  }
  barrierRecords() {
    // Fixed identity/representation metadata only, never body or credential.
    // This is for authenticated exact-set observation, NOT replay.
    return [...this.#records.values()].map(r=>({localId:r.localId,id:r.id||null,epoch:r.epoch||null,sha:r.sha,length:r.length,population:{...r.population},inputUntil:r.inputUntil,retainUntil:r.retainUntil}));
  }
  summary() {
    this.#expire();
    return {
      ...this.#archived,
      retainedRecords: this.#records.size,
      retainedBytes: this.#bytes,
      sdkLocalSpool: false,
      custodyIsBackendStored: false,
      recoveryMode: wire.RECOVERY,
      scope: "Current SDK process observations; Agent custody is separate from backend storage and current live eligibility",
    };
  }
  #publish() {
    try {
      this.#change?.(this.snapshot());
    } catch {}
  }
  #enqueue(fn) {
    this.#pending++;
    const work = async () => {
      try {
        return await fn();
      } finally {
        this.#pending--;
      }
    };
    this.#chain = this.#chain.then(work, work);
    return this.#chain;
  }
  async #call(path, body) {
    if (this.#stopped) wire.fail();
    const c = new AbortController();
    this.#active = c;
    try {
      const res = await this.#send(this.#origin, this.#key, path, body, c.signal);
      if (c.signal.aborted || this.#stopped || res?.status !== 200) wire.fail();
      return res.body;
    } finally {
      if (this.#active === c) this.#active = null;
    }
  }
  #observe(r, v) {
    wire.input(v, r);
    if (r.acknowledged && v.state === "issued") wire.fail();
    if (v.backendId) {
      r.backendId = v.backendId;
      r.backendUntil = v.backendUntil;
      r.backendReceiptUntil = v.backendReceiptUntil;
    }
    if (r.backendStored && v.state !== "stored") wire.fail();
    if (r.accounting) {
      for (const k of Object.keys(r.accounting)) if (v.accounting?.[k] !== r.accounting[k]) wire.fail();
    }
    r.state = v.state;
    r.custodyObserved = v.custody;
    r.backendStored = v.backendStored;
    r.observedAt = this.#clock().wall;
    if (v.backendStored) {
      r.accounting = { ...v.accounting };
      r.receiptOnly = true;
    }
    if (v.custody || v.backendStored) {
      r.acknowledged = true;
      this.#release(r);
    }
    if (v.state === "expired-unconfirmed") {
      r.receiptOnly = true;
      this.#release(r);
    }
  }
  async #receipt(r) {
    if (!r.id || !r.mayHaveLeft || r.receiptAttempts >= LIMITS.receipts || !r.leaseStart || this.#age(r.leaseStart).ms >= LIMITS.retentionMs) return;
    r.receiptAttempts++;
    try {
      this.#observe(r, await this.#call("/receipt", { id: r.id, epoch: r.epoch }));
    } catch {
      if (!r.acknowledged) r.state = "unconfirmed";
    }
  }
  export(metrics, callback) {
    let called = false;
    const done = (result) => {
      if (!called) {
        called = true;
        try {
          callback(result);
        } catch {}
      }
    };
    if (this.#stopped) return done({ code: 1, error: Error("Normal custody exporter stopped") });
    this.#expire();
    if (this.#records.size >= LIMITS.records || this.#pending >= LIMITS.records) return done({ code: 1, error: Error("Normal custody memory backpressure") });
    let body, p;
    try {
      p = population(metrics);
      body = Buffer.from(ProtobufMetricsSerializer.serializeRequest(metrics));
      if (!body.length || body.length > LIMITS.inputBytes || this.#bytes + body.length > LIMITS.bytes) wire.fail();
    } catch {
      return done({ code: 1, error: Error("Normal custody representation or memory refusal") });
    }
    const r = {
      localId: randomUUID(),
      start: this.#clock(),
      body,
      length: body.length,
      sha: createHash("sha256").update(body).digest("hex"),
      population: { ...p },
      state: "queued",
      leaseAttempts: 0,
      dataAttempts: 0,
      receiptAttempts: 0,
      mayHaveLeft: false,
      acknowledged: false,
      custodyObserved: false,
      backendStored: false,
      done,
    };
    this.#records.set(r.localId, r);
    this.#bytes += body.length;
    this.#enqueue(async () => {
      try {
        this.#expire();
        if (!this.#stopped && this.#records.has(r.localId)) await this.#attempt(r);
      } catch {
        if (!r.acknowledged) r.state = r.mayHaveLeft ? "unconfirmed" : "blocked-unsent";
      } finally {
        this.#release(r);
        done(r.acknowledged ? { code: 0 } : { code: 1, error: Error("Normal custody not confirmed; never replay this export") });
        this.#publish();
      }
    });
  }
  async #attempt(r) {
    const cap = wire.capability(await this.#call("/capabilities"));
    if (!cap.dataClockAvailable) wire.fail();
    r.epoch = cap.epoch;
    let a = this.#age(r.start);
    if (a.unsafe || a.ms >= LIMITS.memoryMs || r.receiptOnly || !r.body) wire.fail();
    r.leaseAttempts++;
    r.leaseStart = this.#clock();
    const l = wire.input(await this.#call("/lease", { sha: r.sha, bytes: r.length, contract: wire.CONTRACT, population: { ...r.population } }), r, true);
    // Never compare Agent wall horizons against this process wall clock. Pin exact
    // returned horizons, use conservative elapsed request-start for SDK sending.
    for (const other of this.#records.values()) if (other !== r && other.id === l.id && other.epoch === l.epoch) wire.fail();
    r.id = l.id;
    r.inputUntil = l.inputUntil;
    r.retainUntil = l.retainUntil;
    a = this.#age(r.leaseStart);
    const age = this.#age(r.start);
    if (a.unsafe || age.unsafe || a.ms >= LIMITS.sendMs || age.ms >= LIMITS.memoryMs || r.receiptOnly || !r.body) wire.fail();
    r.dataAttempts = 1;
    r.mayHaveLeft = true;
    r.receiptOnly = true;
    r.state = "sending";
    try {
      this.#observe(r, await this.#call("/metrics", { id: r.id, epoch: r.epoch, bytes: r.body }));
    } catch {
      r.state = "unconfirmed";
    }
    if (!r.acknowledged) await this.#receipt(r);
  }
  recover(localId) {
    if (this.#stopped) return Promise.reject(Error("Normal custody exporter stopped"));
    this.#expire();
    const r = this.#records.get(String(localId));
    if (!r) return Promise.reject(Error("No retained normal custody record"));
    if (r.recovering) return r.recovering;
    if (!r.id || !r.mayHaveLeft || r.backendStored || r.receiptAttempts >= LIMITS.receipts || r.state === "expired-unconfirmed")
      return Promise.resolve(this.snapshot());
    if (this.#pending >= 20) return Promise.reject(Error("Normal custody recovery backpressure"));
    r.recovering = this.#enqueue(async () => {
      try {
        this.#expire();
        if (!this.#stopped && this.#records.has(r.localId) && !r.backendStored) await this.#receipt(r);
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
  shutdown() {
    if (this.#shutdown) return this.#shutdown;
    this.#stopped = true;
    this.#active?.abort();
    for (const r of this.#records.values()) {
      r.done(r.acknowledged ? { code: 0 } : { code: 1, error: Error("Normal custody SDK stopped before confirmed ACK") });
      this.#release(r);
    }
    this.#shutdown = this.#chain.then(() => this.#publish());
    return this.#shutdown;
  }
}
module.exports = { NormalCustodyExporter, LIMITS };
