// Local webhook receiver for monitor notifications. Appends every delivery to $OUT (JSON lines) and can be told to
// fail on purpose: POST /control {"fail": N} makes the next N deliveries return 503 (used by the alert-reliability tests).
const http = require('http');
const fs = require('fs');
const OUT = process.env.OUT || require('path').join(require('os').tmpdir(), 'monitoring-webhooks.jsonl');
const PORT = Number(process.env.PORT || 5400);
let failNext = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/control') {
      const c = JSON.parse(body || '{}');
      if (typeof c.fail === 'number') failNext = c.fail;
      res.end(JSON.stringify({ failNext }));
      return;
    }
    const failing = failNext > 0;
    if (failing) failNext--;
    let json; try { json = JSON.parse(body); } catch { json = body; }
    fs.appendFileSync(OUT, JSON.stringify({ ts: Date.now(), path: req.url, status: failing ? 503 : 200, body: json }) + '\n');
    res.statusCode = failing ? 503 : 200;
    res.end(failing ? 'unavailable' : 'ok');
  });
}).listen(PORT, () => console.log(`webhook receiver on :${PORT} -> ${OUT}`));
