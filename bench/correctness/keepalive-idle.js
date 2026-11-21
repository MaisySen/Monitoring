// Keep-alive idle-close regression: Node's default server keepAliveTimeout (5s) closes idle
// sockets while long-pooling clients still hold them, and a reuse racing that close surfaces
// as client-side ECONNRESET (measured in soak evidence: server closed idle sockets ~6s after
// a response; 6 resets in 7,492 soak requests). The server must keep idle keep-alive sockets
// open well beyond that (>= 20s observed here; configured 65s).
//
// Positive control: the POST must be accepted (200), so a later "socket stayed open" reading
// is about the timeout, not about a rejected request.
'use strict';
const http = require('node:http');
const BASE = new URL(process.env.MONITORING_URL || process.env.SERVER_URL || 'http://127.0.0.1:4730');
const KEY = process.env.MONITORING_API_KEY || process.env.API_KEY;
if (!KEY) { console.error('set API_KEY (or MONITORING_API_KEY)'); process.exit(2); }
const MIN_OPEN_MS = Number(process.env.KEEPALIVE_MIN_OPEN_MS || 20000);
const body = JSON.stringify({ resourceSpans: [] });
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
let closedAt = null;
const origCreate = agent.createConnection;
agent.createConnection = function (...args) {
  const s = origCreate.apply(this, args);
  s.on('close', () => { if (closedAt === null) closedAt = Date.now(); });
  return s;
};
const req = http.request(`${BASE.origin}/otlp/v1/traces`, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'dc-api-key': KEY } }, (res) => {
  if (res.statusCode !== 200) { console.log(JSON.stringify({ pass: false, stage: 'control', status: res.statusCode })); process.exit(1); }
  res.resume();
  res.on('end', () => {
    const respondedAt = Date.now();
    const iv = setInterval(() => {
      if (closedAt !== null) {
        clearInterval(iv);
        const openMs = closedAt - respondedAt;
        console.log(JSON.stringify({ pass: false, server_closed_idle_socket_after_ms: openMs, required_min_ms: MIN_OPEN_MS }));
        process.exit(1);
      }
      if (Date.now() - respondedAt >= MIN_OPEN_MS) {
        clearInterval(iv);
        agent.destroy();
        console.log(JSON.stringify({ pass: true, idle_socket_open_ms_observed: MIN_OPEN_MS, note: 'still open at threshold, closed by client' }));
        process.exit(0);
      }
    }, 100);
  });
});
req.on('error', (e) => { console.log(JSON.stringify({ pass: false, error: e.code || e.message })); process.exit(1); });
req.end(body);
