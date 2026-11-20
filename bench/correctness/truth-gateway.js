// Known-behaviour Node service for the correctness harness (instrumented with @monitoring/trace, through the Monitoring Agent).
//   GET /op/fast|medium|slow   sleeps 10 / 50 / 200 ms, 200 OK, one info log
//   GET /op/fail               sleeps 20 ms, 500, one error log
//   GET /op/chain              calls the Python service over HTTP (it queries SQLite and logs), 200, one info log
// Every request increments truth.requests{kind}. The response carries the trace ID so the harness can look traces up.
const express = require('express');
const winston = require('winston');
const { trace } = require('@opentelemetry/api');
const { metrics } = require('@monitoring/trace');
const log = winston.createLogger({ level: 'info', format: winston.format.json(), transports: [new winston.transports.File({ filename: require('path').join(process.env.TRUTH_LOG_DIR || '/tmp', 'truth-gateway.log') })] });
const SLEEP = { fast: 10, medium: 50, slow: 200, fail: 20 };
const PY = 'http://127.0.0.1:5301';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const app = express();
app.get('/op/:kind', async (req, res) => {
  const kind = req.params.kind, rid = req.query.rid;
  res.set('x-trace-id', trace.getActiveSpan()?.spanContext().traceId || '');
  metrics.increment('truth.requests', 1, { kind });
  if (kind === 'chain') {
    const r = await fetch(`${PY}/lookup?rid=${rid}`);
    log.info('chain done', { rid, kind, downstream_status: r.status });
    return res.status(r.status).json(await r.json());
  }
  await sleep(SLEEP[kind] ?? 0);
  if (kind === 'fail') { log.error('operation failed', { rid, kind }); return res.status(500).json({ error: 'injected' }); }
  log.info('operation ok', { rid, kind });
  res.json({ ok: true });
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(5300);
