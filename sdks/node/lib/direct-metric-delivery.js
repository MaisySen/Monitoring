"use strict";
// Explicit connected EXPERIMENT only. No disk spool and NO automatic data resends.
const { createHash, randomUUID } = require("node:crypto");
const { ProtobufMetricsSerializer } = require("@opentelemetry/otlp-transformer");
const { AggregationTemporality, DataPointType } = require("@opentelemetry/sdk-metrics");
class DirectMetricDelivery {
  constructor(base, headers, onChange) {
    this.base = base.replace(/\/+$/, "") + "/otlp/experimental/metric-delivery/v1";
    this.headers = { ...headers };
    this.onChange = onChange;
    this.records = new Map();
    this.archived = { unknownBatches: 0, lostBatches: 0, firstAt: null, lastAt: null };
    this.chain = Promise.resolve();
    this.stopped = false;
  }
  snapshot() {
    this.clean();
    return [...this.records.values()].map(({ localId, id, state, reason, attempts, until, receiptUntil, body }) => ({
      localId,
      id,
      state,
      reason,
      attempts,
      until,
      receiptUntil,
      retainedBytes: body?.length || 0,
      localSpool: false,
    }));
  }
  publish() {
    for (const r of this.records.values())
      if (r.token)
        void this.request("/diagnostic", { token: r.token, localId: r.localId, state: r.state, attempts: r.attempts, retainedBytes: r.body?.length || 0 })
          .then((res) => res.arrayBuffer())
          .catch(() => {});
    try {
      this.onChange?.(this.snapshot());
    } catch {
      /* diagnostic consumer must not crash export */
    }
  }
  clean() {
    const now = Date.now();
    for (const [k, r] of this.records) {
      if ((r.receiptUntil && now > r.receiptUntil) || (!r.token && now - r.born > 60000)) {
        if (r.state !== "stored") {
          const lost = !r.token || r.state === "lost";
          this.archived[lost ? "lostBatches" : "unknownBatches"]++;
          this.archived.firstAt ??= now;
          this.archived.lastAt = now;
        }
        this.records.delete(k);
        continue;
      }
      if (!r.token && now - r.born >= 30000) {
        r.state = "lost";
        r.reason = "Unsent memory window expired";
        r.body = null;
      }
      if (r.until && now >= r.until && !["stored", "unknown", "lost"].includes(r.state)) {
        r.state = "expired-unconfirmed";
        r.reason = "No new data sends; receipt lookup only";
        r.body = null;
      }
    }
  }
  summary() {
    this.clean();
    return { ...this.archived, scope: "Current process only, not durable across restart", retainedRecords: this.records.size };
  }
  selectAggregationTemporality() {
    return AggregationTemporality.DELTA;
  }
  export(metrics, done) {
    if (this.stopped) return done({ code: 1, error: Error("delivery exporter stopped") });
    let n = 0;
    for (const scope of metrics.scopeMetrics || [])
      for (const m of scope.metrics || []) {
        if (![DataPointType.SUM, DataPointType.GAUGE].includes(m.dataPointType))
          return done({ code: 1, error: Error("Experimental direct delivery only supports delta sums and gauges") });
        n += m.dataPoints.length;
      }
    if (!n) return done({ code: 0 });
    this.clean();
    if (this.records.size >= 10) return done({ code: 1, error: Error("Metric delivery diagnostics/queue capacity reached") });
    const body = Buffer.from(ProtobufMetricsSerializer.serializeRequest(metrics));
    if (body.length > 1024 * 1024) return done({ code: 1, error: Error("Experimental metric body limit1MiB") });
    const r = { localId: randomUUID(), state: "collecting", reason: "Memory only, not durable", attempts: 0, body, born: Date.now() };
    this.records.set(r.localId, r);
    this.publish();
    this.chain = this.chain
      .then(() => this.attempt(r))
      .then(
        () => done(r.state === "stored" || r.state === "custody" ? { code: 0 } : { code: 1, error: Error(r.reason) }),
        (e) => {
          r.state = "blocked";
          r.reason = "Delivery unconfirmed";
          this.publish();
          done({ code: 1, error: Error("Metric delivery unconfirmed") });
        },
      );
  }
  async request(path, body) {
    const response = await fetch(this.base + path, {
      method: body ? "POST" : "GET",
      headers: { ...this.headers, ...(path === "/metrics" ? { "content-type": "application/x-protobuf" } : { "content-type": "application/json" }) },
      body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    return response;
  }
  async receipt(r) {
    if (!r.token) return;
    try {
      const res = await this.request("/receipt", { token: r.token });
      if (!res.ok) return;
      const state = await res.json();
      if (state.state === "stored") {
        r.state = "stored";
        r.reason = "Backend synchronous commit confirmed by receipt";
        r.body = null;
      } else if (state.state === "unknown") {
        r.state = "unknown";
        r.reason = "Receipt expired; do not resend these deltas";
        r.body = null;
      }
    } catch {
      /* keep visible unconfirmed state */
    }
  }
  async attempt(r) {
    if (this.stopped) return;
    if (r.token) {
      await this.receipt(r);
      if (r.state === "stored" || r.state === "unknown") {
        this.publish();
        return;
      }
    }
    if (r.attempts >= 3) {
      r.state = "blocked";
      r.reason = "Three-attempt budget exhausted";
      this.publish();
      return;
    }
    if (r.until && Date.now() >= r.until) {
      r.state = "expired-unconfirmed";
      r.body = null;
      await this.receipt(r);
      this.publish();
      return;
    }
    if (!r.token && Date.now() - r.born > 30000) {
      r.state = "lost";
      r.reason = "Unsent memory window expired; not recoverable";
      r.body = null;
      this.publish();
      return;
    }
    r.attempts++;
    r.state = "sending";
    r.reason = "Not confirmed stored";
    this.publish();
    try {
      if (!r.token) {
        const cap = await this.request("/capabilities");
        const c = cap.ok ? await cap.json() : null;
        if (c?.protocol !== "monitoring-node-direct-test-v1" || c?.storage !== "postgres") throw Error("unsupported");
        const lease = await this.request("/lease", { sha: createHash("sha256").update(r.body).digest("hex") });
        if (!lease.ok) {
          r.state = "blocked";
          r.reason = lease.status === 403 ? "API key refused; explicit recovery required" : "Lease unavailable; explicit recovery required";
          this.publish();
          return;
        }
        const l = await lease.json();
        if (
          typeof l.token !== "string" ||
          !/^d_[a-f0-9]{32}$/.test(l.id) ||
          !Number.isSafeInteger(l.until) ||
          !Number.isSafeInteger(l.receiptUntil) ||
          l.receiptUntil < l.until
        )
          throw Error("invalid lease");
        r.token = l.token;
        r.id = l.id;
        r.until = l.until;
        r.receiptUntil = l.receiptUntil;
      }
      const res = await fetch(this.base + "/metrics", {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/x-protobuf", "x-monitoring-delivery-token": r.token },
        body: r.body,
        signal: AbortSignal.timeout(5000),
      });
      await res.arrayBuffer();
      if (res.ok) {
        r.state = "stored";
        r.reason = "Backend synchronous commit acknowledged";
        r.body = null;
      } else {
        r.state = res.status === 410 ? "expired-unconfirmed" : "blocked";
        r.reason =
          res.status === 403
            ? "API key refused; explicit recovery required"
            : res.status === 429
              ? "Quota/backpressure; explicit bounded recovery required"
              : "Delivery refused/unconfirmed; inspect receipt before recovery";
        if (res.status >= 500 || res.status === 410) await this.receipt(r);
      }
    } catch {
      r.state = "blocked";
      r.reason = "Network/capability failure; no automatic data resend";
      await this.receipt(r);
    }
    this.publish();
  }
  async recover(localId) {
    const r = this.records.get(String(localId));
    if (!r) throw Error("No retained delivery record");
    if (r.state === "stored") return this.snapshot();
    this.chain = this.chain.then(() => this.attempt(r));
    await this.chain;
    return this.snapshot();
  }
  async forceFlush() {
    await this.chain;
  }
  async shutdown() {
    await this.chain;
    this.stopped = true;
    for (const r of this.records.values())
      if (r.state !== "stored") {
        r.body = null;
        r.state = "lost";
        r.reason = "Process/exporter stopped without durable local spool";
      }
    this.publish();
  }
}
module.exports = { DirectMetricDelivery };
