'use strict';

function tags(value) {
  if (!value) return {};
  if (!Array.isArray(value) && typeof value === 'object') return { ...value };
  return Object.fromEntries((Array.isArray(value) ? value : value.split(','))
    .filter(Boolean).map(item => {
      const index = item.indexOf(':');
      return index < 0 ? [item, true] : [item.slice(0, index), item.slice(index + 1)];
    }));
}

function config(options = {}, rawEnv = process.env) {
  const env = rawEnv;
  const first = (...values) => values.find(v => v !== undefined && v !== '');
  const bool = (value, fallback) => value === undefined ? fallback : String(value).toLowerCase() !== 'false';
  const url = first(options.url, env.MONITORING_URL);
  const key = first(options.apiKey, env.MONITORING_API_KEY);
  const metricCustodyTest = env.MONITORING_METRIC_CUSTODY_TEST_ONLY === 'yes';
  if(metricCustodyTest&&(!env.MONITORING_METRIC_CUSTODY_URL||!key||env.MONITORING_METRICS_RETRY==='true'||env.MONITORING_METRIC_DIRECT_TEST_ONLY==='yes'))throw new Error('Agent custody test requires explicit custody URL/API key, no direct test and extra retries OFF');
  const metricDirectTest = env.MONITORING_METRIC_DIRECT_TEST_ONLY === 'yes';
  if (metricDirectTest && (!url || !key || env.MONITORING_METRICS_RETRY === 'true')) throw new Error('Experimental direct metric delivery requires explicit URL/API key and extra retries OFF');
  if (url && !key) throw new Error('MONITORING_URL requires MONITORING_API_KEY');
  const base = (url ? `${url.replace(/\/+$/, '')}/otlp` :
    first(options.agentUrl, env.MONITORING_AGENT_URL, env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318')).replace(/\/+$/, '');
  const headers = Object.fromEntries((env.OTEL_EXPORTER_OTLP_HEADERS || '').split(',').filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    if (i < 1) throw new Error('Invalid OTEL_EXPORTER_OTLP_HEADERS');
    return [pair.slice(0, i).trim(), decodeURIComponent(pair.slice(i + 1).trim())];
  }));
  if (url) headers['DC-API-KEY'] = key;
  const sampleRate = Number(first(options.sampleRate, env.MONITORING_SAMPLE_RATE, env.OTEL_TRACES_SAMPLER_ARG, 1));
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error('MONITORING_SAMPLE_RATE must be between 0 and 1');
  const attributes = {};
  for (const pair of (env.OTEL_RESOURCE_ATTRIBUTES || '').split(',').filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0) attributes[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
  }
  Object.assign(attributes, tags(first(options.tags, env.MONITORING_TAGS, env.DD_TAGS)));
  attributes['service.name'] = first(options.service, env.MONITORING_SERVICE, env.OTEL_SERVICE_NAME, attributes['service.name'], env.DD_SERVICE, 'node-app');
  const version = first(options.version, env.MONITORING_VERSION, attributes['service.version'], env.DD_VERSION);
  const environment = first(options.env, env.MONITORING_ENV, attributes['deployment.environment'], attributes['deployment.environment.name'], env.DD_ENV);
  if (version) attributes['service.version'] = version;
  if (environment) attributes['deployment.environment'] = environment;
  attributes['telemetry.distro.name'] = 'monitoring';
  attributes['telemetry.distro.version'] = '0.1.0';
  return {
    attributes, headers, sampleRate, metricDirectTest, directUrl: url, metricCustodyTest,custodyUrl:env.MONITORING_METRIC_CUSTODY_URL,custodyKey:key,
    sampleRateOverride: first(options.sampleRate, env.MONITORING_SAMPLE_RATE) !== undefined,
    logsInjection: bool(first(options.logsInjection, env.MONITORING_LOGS_INJECTION), true),
    // Ship log records over OTLP from the app. Turn off when the Monitoring Agent tails the app's log files instead.
    logShipping: bool(first(options.logShipping, env.MONITORING_LOG_SHIPPING), true),
    runtimeMetrics: bool(first(options.runtimeMetrics, env.MONITORING_RUNTIME_METRICS), false),
    traceNetwork: bool(first(options.traceNetwork, env.MONITORING_TRACE_NETWORK), false),
    traceMiddleware: bool(first(options.traceMiddleware, env.MONITORING_TRACE_MIDDLEWARE), false),
    // Connection-pool checkout spans (pg-pool.connect) are opt-in: they add ~1.3 spans per query-bearing request and carry no query.
    // Flush buffered spans, logs and metrics when the process gets SIGTERM/SIGINT (Node skips beforeExit on signals).
    handleSignals: bool(first(options.handleSignals, env.MONITORING_HANDLE_SIGNALS), true),
    traceDbConnect: bool(first(options.traceDbConnect, env.MONITORING_TRACE_DB_CONNECT), false),
    traceRouter: bool(first(options.traceRouter, env.MONITORING_TRACE_ROUTER), false),
    // Route-handler child spans are opt-in: the server span already carries the route (GET /users/:id), and skipping them cuts ~25% of per-request CPU.
    traceHandlers: bool(first(options.traceHandlers, env.MONITORING_TRACE_HANDLERS), false),
    httpMetrics: bool(first(options.httpMetrics, env.MONITORING_HTTP_METRICS), false),
    exporter: first(options.exporter, env.MONITORING_EXPORTER) || 'monitoring',
    fastHttp: bool(first(options.fastHttp, env.MONITORING_FAST_HTTP), true),
    ignorePaths: first(options.ignorePaths, env.MONITORING_IGNORE_PATHS ? env.MONITORING_IGNORE_PATHS.split(',') : undefined) || [],
    metricInterval: Number(first(options.metricInterval, env.OTEL_METRIC_EXPORT_INTERVAL, 10000)),
    endpoint: signal => !url && !options.agentUrl && !env.MONITORING_AGENT_URL && env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] ||
      `${base}/v1/${signal}`,
  };
}

module.exports = { config, tags };
