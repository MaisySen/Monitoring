// Keep-alive race repro harness: many parallel keep-alive sockets, each idled to a
// staggered point around the server's idle close, then reused. Counts ECONNRESET.
// Usage: SERVER_URL=... API_KEY=... node bench/correctness/keepalive-race-repro.js [port] [loMs] [hiMs] [n]
// Evidence: bench/evidence/soak-2026-11-21/RESET-MECHANISM.md
'use strict';
// Parallel boundary repro: many keep-alive sockets, each idled to a staggered point
// around the server's observed ~6000ms idle close; second POST reuses the same socket.
// Usage: node race-repro.js <port> <staggerStartMs> <staggerEndMs> <n>
const http = require('node:http');
const KEY = require('child_process').execSync('cat /tmp/reg-key').toString().trim();
const [port, lo, hi, n] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];
const body = JSON.stringify({ resourceSpans: [] });
function post(agent) {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/otlp/v1/traces`, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'dc-api-key': KEY } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(body);
  });
}
(async () => {
  const results = { resets: 0, ok: 0, other: [] };
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const r1 = await post(agent);
    const respondedAt = Date.now();
    const delay = lo + ((hi - lo) * i) / Math.max(1, n - 1);
    await new Promise((r) => setTimeout(r, Math.max(0, delay - (Date.now() - respondedAt))));
    const r2 = await post(agent);
    if (r2.error === 'ECONNRESET') results.resets++;
    else if (r2.status === 200) results.ok++;
    else results.other.push(r2);
    agent.destroy();
  }));
  console.log(JSON.stringify({ port, staggerMs: [lo, hi], attempts: n, firstReq: 'all 200 assumed', ...results, other: results.other.slice(0, 3) }));
})();
