'use strict';
// Optional bounded on-disk spool for the direct (agentless) export path.
//
// The in-memory retry window (MONITORING_EXPORT_RETRY_SECONDS, default 30 s) covers agent restarts
// and brief network failures. A longer server outage still drops batches once the window closes.
// With MONITORING_EXPORT_SPOOL_DIR set, a batch whose retries are exhausted is appended to that
// directory instead of being dropped, and a background drain re-sends spooled batches oldest-first
// once the endpoint answers again. Spans and logs share the directory through separate prefixes.
//
// Bounds: MONITORING_EXPORT_SPOOL_MAX_MB (default 50) caps total spool bytes; once over the cap the
// OLDEST files are dropped and the drop count is logged, so a disk can never fill and the newest
// telemetry always wins. Spool files survive process restarts: any later process started with the
// same directory drains what a crashed process left behind.
//
// Ordering note: batches that overflow to the spool are re-sent after the outage, so they can
// arrive out of order relative to batches exported after recovery. Telemetry is timestamped, so
// queries are unaffected; only live-tail ordering can briefly interleave.
const fs = require('fs');
const path = require('path');

class Spool {
  constructor(dir, { maxBytes = Number(process.env.MONITORING_EXPORT_SPOOL_MAX_MB ?? 50) * 1024 * 1024, prefix = 'spool', log = console.error } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.prefix = prefix;
    this.log = log;
    this.droppedTotal = 0;
    fs.mkdirSync(dir, { recursive: true });
  }
  files() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.startsWith(this.prefix + '-')).sort();
    } catch {
      return [];
    }
  }
  bytes() {
    return this.files().reduce((s, f) => { try { return s + fs.statSync(path.join(this.dir, f)).size; } catch { return s; } }, 0);
  }
  // Persist a payload; never throws: a spool failure must not crash the application.
  write(payload) {
    try {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
      const name = `${this.prefix}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.bin`;
      fs.writeFileSync(path.join(this.dir, name), buf);
      let total = this.bytes();
      if (total > this.maxBytes) {
        for (const f of this.files()) {
          if (total <= this.maxBytes) break;
          try {
            total -= fs.statSync(path.join(this.dir, f)).size;
            fs.unlinkSync(path.join(this.dir, f));
            this.droppedTotal++;
          } catch { /* keep going */ }
        }
        this.log(`[monitoring] spool over ${Math.round(this.maxBytes / 1048576)} MB: dropped ${this.droppedTotal} oldest batch(es) in total`);
      }
    } catch (e) {
      this.log(`[monitoring] spool write failed: ${e.message}`);
    }
  }
  // Re-send spooled payloads oldest-first through send(payload) -> Promise<boolean>.
  // Stops at the first failure (endpoint still down); one corrupt file is skipped, not fatal.
  async drain(send) {
    let sent = 0;
    for (const f of this.files()) {
      const p = path.join(this.dir, f);
      let payload;
      try {
        payload = fs.readFileSync(p);
      } catch {
        continue;
      }
      let ok = false;
      try {
        ok = await send(this.prefix === 'logs' ? JSON.parse(payload.toString()) : payload);
      } catch {
        ok = false;
      }
      if (!ok) return sent;
      try { fs.unlinkSync(p); } catch { /* drained on next pass */ }
      sent++;
    }
    if (sent > 0) this.log(`[monitoring] spool drained ${sent} ${this.prefix} batch(es)`);
    return sent;
  }
}

// Shared drain pump: one per exporter, started lazily on the first overflow and at construction.
// Calls attempt() -> Promise<boolean> (true = endpoint reachable and spool empty or flushed).
function startDrainPump(spool, attempt, { intervalMs = 5000 } = {}) {
  let timer = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (await attempt()) {
        if (timer) { clearInterval(timer); timer = null; }
        return;
      }
    } finally {
      running = false;
    }
  };
  return () => {
    tick();
    if (!timer) {
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    }
  };
}

module.exports = { Spool, startDrainPump };
