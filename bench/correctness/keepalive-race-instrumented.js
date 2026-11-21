// Instrumented keep-alive reuse-race probe.
// Same geometry as keepalive-race-repro.js (n parallel keep-alive sockets, second POST
// staggered lo..hi ms after each socket's own first response), but records for every
// second request whether the client had ALREADY seen the socket close before writing.
// Separates "wrote into an already-closed socket" from "wrote during server's close".
// Usage: node bench/correctness/keepalive-race-instrumented.js <port> <loMs> <hiMs> <n>
'use strict';
const http = require('node:http');
const KEY = require('child_process').execSync('cat /tmp/reg-key').toString().trim();
const [port, lo, hi, n] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];
const body = JSON.stringify({ resourceSpans: [] });

function post(agent, onSocket) {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/otlp/v1/traces`, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'dc-api-key': KEY } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    if (onSocket) req.on('socket', onSocket);
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(body);
  });
}

(async () => {
  const tally = {};
  const bump = (k) => { tally[k] = (tally[k] || 0) + 1; };
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    let sock = null, closedBeforeReuse = false, closeAtMs = -1;
    const r1 = await post(agent, (s) => { sock = s; });
    if (r1.status !== 200) { bump(`first_${r1.error || r1.status}`); agent.destroy(); return; }
    const respondedAt = Date.now();
    sock.on('close', () => { closeAtMs = Date.now() - respondedAt; });
    const delay = lo + ((hi - lo) * i) / Math.max(1, n - 1);
    await new Promise((r) => setTimeout(r, Math.max(0, delay - (Date.now() - respondedAt))));
    closedBeforeReuse = closeAtMs >= 0;
    const r2 = await post(agent);
    const cls = r2.error ? r2.error : r2.status;
    bump(`${closedBeforeReuse ? 'seenClosed' : 'unseen'}_${cls}`);
    agent.destroy();
  }));
  console.log(JSON.stringify({ port, staggerMs: [lo, hi], attempts: n, tally }));
})();
