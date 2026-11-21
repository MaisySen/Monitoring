# @monitoring/trace

Monitoring tracing, metrics and correlated logs on the OpenTelemetry SDK. Requires Node.js 22.15+ (Node 24 recommended).

## Install and start

```sh
npm install @monitoring/trace
MONITORING_SERVICE=checkout node -r @monitoring/trace/init app.js
```

From a checkout of this repository: `cd sdks/node && npm ci`, then
`MONITORING_SERVICE=node-example node -r ./init examples/app.js`.
Initialize **before** loading Express, HTTP clients, database drivers or loggers:

```js
const { tracer, metrics } = require('@monitoring/trace').init({
  service: 'checkout', env: 'production', version: '1.2.3'
});
const express = require('express');
const app = express();
app.get('/', async (req, res) => {
  await tracer.trace('checkout.calculate', { resource: 'cart', tags: { region: 'us' } }, async span => {
    span.setAttribute('cart.items', 2);
    metrics.increment('checkout.requests', 1, ['region:us']);
  });
  res.send('ok');
});
app.listen(8081);
```

Auto-instrumentation includes HTTP, Express, PostgreSQL, fetch/undici, Redis and other supported libraries. W3C trace context propagates across supported clients and servers. `tracer.trace` returns the callback's value (or promise), records exceptions and always ends the span. Its span is a native OTel span with an additional `setTag` alias.

Winston, Pino and Bunyan records receive `trace_id`/`span_id` in active spans and ship directly over OTLP; stdout/file tailing is not required. Initialize before importing these loggers. `console.log` is not a structured logger and is not shipped.

## Destination and configuration

Defaults to an agent at `http://localhost:4318`. Agentless:

```sh
MONITORING_URL=https://your-monitoring.example MONITORING_API_KEY="$YOUR_KEY" \
MONITORING_SERVICE=checkout node -r @monitoring/trace/init app.js
```

Delivery guarantees. With the spool disabled (default), spans and logs are retried in memory for `MONITORING_EXPORT_RETRY_SECONDS` and then dropped; a process crash loses what is in memory. With `MONITORING_EXPORT_SPOOL_DIR` set, span and log batches are persisted before retry and reclaimed if the process dies mid-drain (60 s stale-claim timeout). Span intake is idempotent per `(trace_id, span_id)`, so a batch re-delivered after a server-side commit with a lost response does not duplicate rows or rollups. Logs and metrics have no producer-assigned key: re-delivery after a lost response can duplicate log rows, and metrics are not spooled at all (dropped after the in-memory retry window). Delivery is therefore **at-least-once**, never exactly-once.

`MONITORING_URL` is the application origin, **without** `/otlp`; signals go to `/otlp/v1/{traces,metrics,logs}` with `DC-API-KEY`. No key is needed when using an agent.

| Variable | Meaning / default |
| --- | --- |
| `MONITORING_SERVICE` | Service name; `OTEL_SERVICE_NAME`, resource attributes, then `DD_SERVICE`; default `node-app` |
| `MONITORING_ENV` | Environment; OTel resource attribute, then `DD_ENV` |
| `MONITORING_VERSION` | Service version; OTel resource attribute, then `DD_VERSION` |
| `MONITORING_TAGS` | Comma-separated `key:value` resource tags; fallback `DD_TAGS` |
| `MONITORING_URL` / `MONITORING_API_KEY` | Agentless application origin and key; missing key is an error |
| `MONITORING_AGENT_URL` | OTLP HTTP agent base; fallback `OTEL_EXPORTER_OTLP_ENDPOINT`, then `http://localhost:4318` |
| `MONITORING_LOGS_INJECTION` | Correlation field injection, default `true`; shipping remains enabled |
| `MONITORING_LOG_SHIPPING` | Ship log records over OTLP from the app, default `true`; set `false` when the Monitoring Agent tails the app's log files (IDs are still injected) |
| `MONITORING_HANDLE_SIGNALS` | Flush spans, logs and metrics on SIGTERM/SIGINT before the process exits, default `true` |
| `MONITORING_EXPORT_RETRY_SECONDS` | How long a span batch is retried while the agent/endpoint is unreachable or returns 408/429/502/503/504, default `30` |
| `MONITORING_EXPORT_SPOOL_DIR` | Disk spool directory for spans and logs; unset (default) disables spooling. While the destination is unreachable, batches are written to disk and drained oldest-first when it recovers, surviving process restarts |
| `MONITORING_EXPORT_SPOOL_MAX_MB` | Per-signal spool cap in MB, default `50`; counts files in flight to a drainer. Oldest files are evicted when the cap is exceeded, and a single batch larger than the cap is dropped; delivery is at-least-once only while the spool has room |
| `MONITORING_TRACE_DB_CONNECT` | Connection-pool checkout spans (`pg-pool.connect`), default `false` |
| `MONITORING_SAMPLE_RATE` | Parent-based root sampling probability `[0,1]`; fallback `OTEL_TRACES_SAMPLER_ARG`, default `1` |
| `MONITORING_RUNTIME_METRICS` | Event-loop delay, heap and OTel runtime metrics; default `false` |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional `key=value` attributes |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Full signal URL when Monitoring destination variables are absent |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated URL-encoded `key=value` headers |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metrics interval in milliseconds; default `10000` |

Programmatic camelCase equivalents: `service`, `env`, `version`, `tags`, `url`, `apiKey`, `agentUrl`, `logsInjection`, `sampleRate`, `runtimeMetrics`, `metricInterval`. Monitoring configuration takes precedence over OTel and migration settings. Resource attributes include `telemetry.distro.name=monitoring` and `telemetry.distro.version`. Exporters always use OTLP/HTTP protobuf; counters and histograms export DELTA temporality.

## Custom metrics and lifecycle

```js
const dc = require('@monitoring/trace');
dc.metrics.increment('orders.total');                 // value defaults to 1
dc.metrics.gauge('queue.depth', 12, { queue: 'work' });
dc.metrics.histogram('orders.duration', 42, ['unit:ms']);
dc.metrics.distribution('orders.size', 100);          // OTel histogram
await dc.forceFlush();
await dc.shutdown();                                 // drains all signals
```

Call `shutdown()` during your application's graceful signal handling, after closing servers. Natural process exit also drains exporters. Do not initialize another OTel provider in the same process. The first initialization wins. This initial release is CommonJS-first; ESM automatic patching requires OTel's ESM loader and is not guaranteed by the preload alone.

## Verification

`npm test` runs configuration tests. `node test/verify.js` starts a temporary local OTLP sink, runs the sample as a child, decodes protobuf requests, and checks spans, correlated logs and DELTA metrics. `MONITORING_VERIFY_REMOTE=true MONITORING_URL=http://localhost:3000 MONITORING_API_KEY=... node test/verify.js` instead sends to Monitoring; check the service `monitoring-node-verify` in the database or UI.

## Experimental metric retries, test use only

Extra metric retries are OFF by default. `MONITORING_METRICS_RETRY=true` enables a test-only
wrapper pending independent safety review. Do not treat the opt-in as production acceptance.
The stock OTLP exporter still has its own retries when this option is off.

The opt-in sends `x-monitoring-batch-id`. PostgreSQL intake with migration 20 dedups an exact
wire-body resend under that id while the claim row remains retained. The hash covers RAW body
bytes, including gzip envelope bytes. Re-encoding equivalent JSON/protobuf or recompressing into
different bytes with the same id returns 409. Changed content needs a new id. There is no semantic
canonicalization. Older servers and ClickHouse do not provide this batch dedup guarantee.

The default client start-send age cutoff is 600 seconds. Keep it well below the server's batch
retention (default 48 hours); this compatibility is operator responsibility, not a negotiated or
enforced cross-service setting. A request already in flight can complete after the cutoff. There
is no disk spool. These limits, the default-off setting, and a passing test suite are not a claim
that the retry wrapper is safe to enable in production.
