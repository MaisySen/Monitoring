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
