// Structured logger. @monitoring/trace injects trace_id/span_id and ships every record to Monitoring over OTLP,
// so nothing tails this file; it is kept only for local debugging.
const winston = require('winston');
module.exports = (svc) => winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: svc },
  transports: [new winston.transports.File({ filename: `${process.env.ACME_LOG_DIR || '/tmp/acme-shop'}/${svc}.log` })],
});
