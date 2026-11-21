"use strict";
const { DirectMetricDelivery } = require("./direct-metric-delivery");
// Only selected explicitly. The app sees custody separately from backendStored.
class AgentMetricCustody extends DirectMetricDelivery {
  constructor(base, headers, onChange) {
    super(base, headers, onChange);
    this.base = base.replace(/\/+$/, "") + "/monitoring/experimental/metric-custody/v1";
  }
  publish() {
    try {
      this.onChange?.(this.snapshot());
    } catch {}
  }
  clean() {
    const now = Date.now();
    for (const [k, r] of this.records) {
      if ((r.receiptUntil && now > r.receiptUntil) || (!r.token && now - r.born > 60000)) {
        if (r.state !== "stored") {
          this.archived.unknownBatches++;
          this.archived.firstAt ??= now;
          this.archived.lastAt = now;
        }
        this.records.delete(k);
      } else if (!r.token && now - r.born > 30000) {
        r.state = "lost";
        r.body = null;
        r.reason = "Unsent memory window expired";
      }
    }
  }
  apply(r, s) {
    if (s.id !== r.id || s.epoch !== r.epoch) throw Error("Agent identity mismatch");
    r.state = s.backendStored ? "stored" : s.custody ? "custody" : s.state;
    r.reason = s.reason;
    r.agentState = s.state;
    r.backendId = s.backendId;
    r.receiptUntil = s.retainUntil;
    if (s.custody || s.backendStored) r.body = null;
  }
  async receipt(r) {
    if (!r.token) return;
    try {
      const res = await this.request("/receipt", { id: r.id, epoch: r.epoch });
      if (res.status === 409 || res.status === 410) {
        r.state = "unknown";
        r.reason = "Agent epoch/receipt ended; do not renew these deltas";
        r.body = null;
        return;
      }
      if (res.ok) this.apply(r, await res.json());
    } catch {}
  }
  async attempt(r) {
    if (this.stopped) return;
    if (r.token) {
      await this.receipt(r);
      if (["custody", "stored", "unknown"].includes(r.state)) {
        this.publish();
        return;
      }
    }
    if (r.attempts >= 3 || !r.body || Date.now() - r.born > 30000) {
      r.state = "lost";
      r.reason = "Finite app memory/send window ended; no identity renewal";
      r.body = null;
      this.publish();
      return;
    }
    r.attempts++;
    r.state = "sending";
    this.publish();
    try {
      if (!r.token) {
        const cap = await this.request("/capabilities");
        const c = cap.ok ? await cap.json() : null;
        if (c?.protocol !== "monitoring-agent-custody-test-v1" || !c.epoch) throw Error("Unsupported agent");
        const l = await this.request("/lease", { sha: require("node:crypto").createHash("sha256").update(r.body).digest("hex") });
        if (!l.ok) throw Error("Input lease unavailable");
        const x = await l.json();
        if (x.epoch !== c.epoch || typeof x.id !== "string" || !Number.isSafeInteger(x.until) || !Number.isSafeInteger(x.retainUntil))
          throw Error("Invalid input identity");
        r.id = x.id;
        r.epoch = x.epoch;
        r.token = x.id;
        r.until = x.until;
        r.receiptUntil = x.retainUntil;
      }
      const res = await fetch(this.base + "/metrics", {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/x-protobuf", "x-monitoring-input-id": r.id, "x-monitoring-agent-epoch": r.epoch },
        body: r.body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) this.apply(r, await res.json());
      else {
        r.state = "blocked";
        r.reason = "Agent custody unconfirmed; explicit same-identity recovery only";
        await this.receipt(r);
      }
    } catch {
      r.state = "blocked";
      r.reason = "Agent response lost/unavailable; no fresh identity";
      await this.receipt(r);
    }
    this.publish();
  }
  async shutdown() {
    await this.chain;
    this.stopped = true;
    this.publish();
  }
  async recover(id) {
    const r = this.records.get(String(id));
    if (!r) throw Error("No retained app record");
    this.chain = this.chain.then(async () => {
      await this.receipt(r);
      if (r.state === "custody") {
        const res = await this.request("/recover", { id: r.id, epoch: r.epoch });
        if (res.ok) this.apply(r, await res.json());
      } else if (!["stored", "unknown"].includes(r.state)) await this.attempt(r);
      this.publish();
    });
    await this.chain;
    return this.snapshot();
  }
  snapshot() {
    const rows = super.snapshot();
    return rows.map((r) => {
      const x = this.records.get(r.localId);
      return { ...r, agentState: x?.agentState, backendId: x?.backendId, custody: r.state === "custody", backendStored: r.state === "stored" };
    });
  }
}
module.exports = { AgentMetricCustody };
