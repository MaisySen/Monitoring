// Phase A: measure the server's idle keep-alive close-time DISTRIBUTION under parallel load.
// Opens n connections, sends one POST on each, records when the server closes each socket
// relative to that socket's response end. Prints percentiles so reuse probes can be aimed
// at the real boundary instead of an assumed one.
// Usage: node bench/correctness/keepalive-close-distribution.js <port> <n> [capMs]
'use strict';
const http = require('node:http');
const KEY = require('child_process').execSync('cat /tmp/reg-key').toString().trim();
const [port, n, capMs] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] || 90000)];
const body = JSON.stringify({ resourceSpans: [] });

function probe() {
  return new Promise((resolve) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const t0 = Date.now();
    const req = http.request(`http://127.0.0.1:${port}/otlp/v1/traces`, {
      method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'dc-api-key': KEY, 'connection': 'keep-alive' },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const respondedAt = Date.now();
        let closedAt = 0;
        sock.on('close', () => { closedAt = Date.now(); agent.destroy(); resolve({ responseMs: respondedAt - t0, idleCloseMs: closedAt - respondedAt }); });
        setTimeout(() => { if (!closedAt) { agent.destroy(); resolve({ responseMs: respondedAt - t0, idleCloseMs: -1 }); } }, Math.max(0, capMs - (Date.now() - t0)));
      });
    });
    let sock;
    req.on('socket', (s) => { sock = s; });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(body);
  });
}

(async () => {
  const rs = await Promise.all(Array.from({ length: n }, probe));
  const closes = rs.map((r) => r.idleCloseMs).filter((v) => v >= 0).sort((a, b) => a - b);
  const errs = rs.filter((r) => r.error);
  const stillOpen = rs.filter((r) => r.idleCloseMs === -1).length;
  const q = (p) => closes.length ? closes[Math.min(closes.length - 1, Math.floor((p / 100) * closes.length))] : null;
  console.log(JSON.stringify({
    port, n, measured: closes.length, stillOpenAtCap: stillOpen, errors: errs.length,
    responseMs_max: Math.max(...rs.map((r) => r.responseMs || 0)),
    idleCloseMs: { min: q(0), p50: q(50), p90: q(90), p99: q(99), max: closes[closes.length - 1] ?? null },
    errorSample: errs.slice(0, 3),
  }));
})();
