'use strict';
// Run: node -r @monitoring/trace/init app.js
const { tracer, metrics, forceFlush, shutdown } = require('..');
const express = require('express');
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console()],
});
const app = express();
app.get('/work', async (req, res) => {
  await tracer.trace('example.work', { resource: 'example', tags: { component: 'example' } }, async () => {
    metrics.increment('monitoring.example.node.requests', 1, { route: 'work' });
    metrics.gauge('monitoring.example.node.queue', 2);
    metrics.histogram('monitoring.example.node.duration', 12);
    logger.info('Monitoring Node example request', { example: true });
  });
  res.json({ ok: true });
});
const server = app.listen(Number(process.env.PORT || 8081), '127.0.0.1');
async function stop() {
  await new Promise(resolve => server.close(resolve));
  await forceFlush();
  await shutdown();
}
process.once('SIGTERM', () => stop().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); }));
process.once('SIGINT', () => stop().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); }));
