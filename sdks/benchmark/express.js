'use strict';
// Intentionally identical request handler in each instrumentation mode.
const express = require('../node/node_modules/express');
const app = express();
app.get('/', (req, res) => res.end('ok'));
const server = app.listen(Number(process.env.PORT), '127.0.0.1');
process.once('SIGTERM', () => {
  server.close(async () => {
    if (process.env.BENCH_MODE === 'monitoring') await require('../node').shutdown();
    process.exit(0);
  });
});
