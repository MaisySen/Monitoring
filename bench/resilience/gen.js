// Numbered telemetry generator for the recovery tests: RATE spans/s, each with attribute seq=N, plus one log line
// (seq=N) for every second span, sent by @monitoring/trace through the Monitoring Agent. Prints {"spans":..,"logs":..} sent.
const { tracer } = require('@monitoring/trace');
const winston = require('winston');
const log = winston.createLogger({ level: 'info', transports: [new winston.transports.Console({ silent: true })] });
const RATE = Number(process.env.RATE || 200), SECONDS = Number(process.env.SECONDS || 90);
let seq = 0, logs = 0;
const t0 = Date.now();
const iv = setInterval(() => {
  const due = Math.min(RATE * SECONDS, Math.floor((Date.now() - t0) / 1000 * RATE));
  while (seq < due) {
    const n = seq++;
    tracer.trace('seq.op', { resource: 'seq' }, (span) => {
      span.setAttribute('seq', n);
      if (n % 2 === 0) { log.info('seq', { seq: n }); logs++; }
    });
  }
  if (seq >= RATE * SECONDS) { clearInterval(iv); setTimeout(() => { console.log(JSON.stringify({ spans: seq, logs })); }, 100); }
}, 20);
