'use strict';

const api = require('@opentelemetry/api');
const { config, tags } = require('./config');
let sdk;
let candidateAppDelivery;
let normalCustodyDelivery;
let normalCustodySelection;
let directMetricDelivery;
let shutdownPromise;
let timer;
let loopDelay;
const instruments = new Map();
const meter = () => api.metrics.getMeter('@monitoring/trace', '0.1.0');
function instrument(kind, name) {
  const key = `${kind}:${name}`;
  if (!instruments.has(key)) {
    const m = meter();
    instruments.set(key, kind === 'counter' ? m.createCounter(name) :
      kind === 'gauge' ? m.createGauge(name) : m.createHistogram(name));
  }
  return instruments.get(key);
}
const metrics = {
  increment(name, value = 1, attributes) { instrument('counter', name).add(value, tags(attributes)); },
  gauge(name, value, attributes) { instrument('gauge', name).record(value, tags(attributes)); },
  histogram(name, value, attributes) { instrument('histogram', name).record(value, tags(attributes)); },
  distribution(name, value, attributes) { instrument('histogram', name).record(value, tags(attributes)); },
};
const tracer = {
  trace(name, options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    options ||= {};
    if (typeof fn !== 'function') throw new TypeError('tracer.trace requires a callback');
    const attributes = tags(options.tags);
    if (options.resource) attributes['resource.name'] = options.resource;
    return api.trace.getTracer('@monitoring/trace', '0.1.0').startActiveSpan(name, { attributes }, span => {
      // Familiar helpers without changing native OTel semantics.
      span.setTag = (key, value) => span.setAttribute(key, value);
      const fail = error => {
        span.recordException(error);
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(error.message || error) });
      };
      try {
        const result = fn(span);
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).catch(error => { fail(error); throw error; }).finally(() => span.end());
        }
        span.end();
        return result;
      } catch (error) { fail(error); span.end(); throw error; }
    });
  },
};

function init(options = {}) {
  if (sdk) {
    const next = require('./lib/normal-custody-selector').selectNormalCustody(options, process.env);
    if (next.normalCustodyTest !== normalCustodySelection.normalCustodyTest ||
        (next.normalCustodyTest && (next.normalCustodyUrl !== normalCustodySelection.normalCustodyUrl || next.normalCustodyKey !== normalCustodySelection.normalCustodyKey || next.normalCustodyShutdown !== normalCustodySelection.normalCustodyShutdown))) {
      throw Error('Cannot change normal custody mode or binding after SDK initialization');
    }
    return module.exports;
  }
  // Flush spans and logs every 500 ms (the OTel default is 5 s) so data shows up in Monitoring quickly.
  process.env.OTEL_BSP_SCHEDULE_DELAY ??= '500';
  process.env.OTEL_BLRP_SCHEDULE_DELAY ??= '500';
  // Bigger batches mean fewer exports per second; a bigger queue avoids dropping spans under bursts.
  process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE ??= '256'; // small batches keep each main-thread encode short (tail latency)
  process.env.OTEL_BSP_MAX_QUEUE_SIZE ??= '16384';
  const c = config(options);
  normalCustodySelection = {normalCustodyTest:c.normalCustodyTest,normalCustodyUrl:c.normalCustodyUrl,normalCustodyKey:c.normalCustodyKey,normalCustodyShutdown:c.normalCustodyShutdown};
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { resourceFromAttributes, defaultResource, processDetector, hostDetector, osDetector } = require('@opentelemetry/resources');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
  const { MonitoringSpanExporter } = require('./lib/span-exporter');
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const contextManager = new AsyncLocalStorageContextManager();
  const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
  const { RetryingLogExporter } = require('./lib/retry-log-exporter');
  const { PeriodicExportingMetricReader, AggregationTemporality } = require('@opentelemetry/sdk-metrics');
  const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
  const { ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace');
  const logHook = (span, record) => {
    const sc = span.spanContext();
    record.trace_id = sc.traceId;
    record.span_id = sc.spanId;
  };
  const logging = {
    disableLogCorrelation: !c.logsInjection,
    disableLogSending: !c.logShipping,
    logHook: c.logsInjection ? logHook : undefined,
  };
  const exporter = signal => ({ url: c.endpoint(signal), headers: c.headers });
  sdk = new NodeSDK({
    contextManager,
    resource: defaultResource().merge(resourceFromAttributes(c.attributes)),
    resourceDetectors: [processDetector, hostDetector, osDetector, { detect: () => resourceFromAttributes(c.attributes) }],
    // Monitoring's single-pass OTLP encoder (MONITORING_EXPORTER=otel switches back to the stock exporter).
    traceExporter: c.exporter === 'otel' ? new OTLPTraceExporter(exporter('traces')) : new MonitoringSpanExporter(exporter('traces')),
    sampler: c.sampleRateOverride ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(c.sampleRate) }) : undefined,
    metricReaders: [new PeriodicExportingMetricReader({
      // Metric export retry is OPT-IN (MONITORING_METRICS_RETRY=true) pending end-to-end safety
      // review. The opt-in path pairs the retry wrapper with MetricBatchTracker: every batch gets
      // one x-monitoring-batch-id across every resend, so a server with intake batch idempotency
      // (migration 20) dedups retries instead of double-counting; backends that ignore the header
      // behave exactly as before. See lib/retry-metric-exporter.js for the exposure note.
      exporter: require('./lib/normal-custody-selector').selectMetricExporter(c,
        (url,key) => { const {NormalCustodyExporter}=require('./lib/normal-custody-exporter'); return normalCustodyDelivery=new NormalCustodyExporter(url,key,options.onNormalCustodyDelivery); },
        () => {
        if(c.candidateAppTest){const {CandidateAppExporter}=require('./lib/candidate-app-exporter');return candidateAppDelivery=new CandidateAppExporter(c.directUrl,c.candidateKey,options.onCandidateMetricDelivery);}
        if(c.metricCustodyTest){const {AgentMetricCustody}=require('./lib/agent-metric-custody');return directMetricDelivery=new AgentMetricCustody(c.custodyUrl,{'DC-API-KEY':c.custodyKey},options.onMetricDelivery);}
        if(c.metricDirectTest){const {DirectMetricDelivery}=require('./lib/direct-metric-delivery');return directMetricDelivery=new DirectMetricDelivery(c.directUrl,c.headers,options.onMetricDelivery);}
        const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
        const { RetryingMetricExporter, MetricBatchTracker } = require('./lib/retry-metric-exporter');
        const mk = (headers) => new OTLPMetricExporter({ ...exporter('metrics'), headers, temporalityPreference: AggregationTemporality.DELTA });
        if (process.env.MONITORING_METRICS_RETRY !== 'true') return mk(c.headers);
        const tracker = new MetricBatchTracker(c.headers);
        return new RetryingMetricExporter(mk(tracker.headers), { tracker });
      }),
      exportIntervalMillis: c.metricInterval,
      ...(c.normalCustodyTest ? {exportTimeoutMillis:25000} : {}),
    })],
    // sdk-logs 3.x takes an options object
    // The stock log exporter drops a batch on the first transport error; wrap it in the same retry
    // discipline as the span path. While an export is being retried the processor's queue absorbs new
    // records, so it must be sized for a backpressure window, not the 2048-record default (~10 s at 200 logs/s).
    logRecordProcessors: c.logShipping ? [new BatchLogRecordProcessor({ exporter: new RetryingLogExporter(new OTLPLogExporter(exporter('logs'))), maxQueueSize: 65536 })] : [],
    instrumentations: [getNodeAutoInstrumentations({
      // Low-value, high-volume spans are off by default (MONITORING_TRACE_NETWORK=true turns them on).
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: c.traceNetwork },
      // Incoming requests are traced by Monitoring's lean diagnostics_channel tracer (lib/http-server.js);
      // MONITORING_FAST_HTTP=false switches back to the stock instrumentation. Outgoing requests stay here.
      '@opentelemetry/instrumentation-http': { disableIncomingRequestInstrumentation: c.fastHttp },
      // Express 5 runs on the 'router' package; the express instrumentation already covers its layers,
      // so the router instrumentation would only add duplicate spans.
      '@opentelemetry/instrumentation-router': { enabled: c.traceRouter },
      // Middleware layers are opt-in (MONITORING_TRACE_MIDDLEWARE=true); route handlers are always traced.
      '@opentelemetry/instrumentation-express': { ignoreLayersType: [...(c.traceMiddleware ? [] : ['middleware', 'router']), ...(c.traceHandlers ? [] : ['request_handler'])] },
      '@opentelemetry/instrumentation-net': { enabled: c.traceNetwork },
      '@opentelemetry/instrumentation-pg': { ignoreConnectSpans: !c.traceDbConnect },
      '@opentelemetry/instrumentation-runtime-node': { enabled: c.runtimeMetrics },
      '@opentelemetry/instrumentation-winston': logging,
      '@opentelemetry/instrumentation-pino': logging,
      '@opentelemetry/instrumentation-bunyan': logging,
    })],
  });
  sdk.start();
  if (c.fastHttp) require('./lib/http-server').install({ contextManager, ignorePaths: c.ignorePaths });
  // Monitoring derives request rate, errors and latency from spans on the server, so the HTTP
  // instrumentations do not need to record their own per-request histograms in-process.
  if (!c.httpMetrics) {
    const noopMeterProvider = { getMeter: () => api.createNoopMeter() };
    for (const inst of sdk._instrumentations ?? []) {
      if (/instrumentation-(http|undici)$/.test(inst.instrumentationName)) inst.setMeterProvider(noopMeterProvider);
    }
  }
  if (c.runtimeMetrics) {
    loopDelay = require('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
    timer = setInterval(() => {
      metrics.gauge('runtime.node.heap.used', process.memoryUsage().heapUsed);
      metrics.gauge('runtime.node.event_loop.delay', Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : 0);
      loopDelay.reset();
    }, 1000);
    timer.unref();
  }
  process.once('beforeExit', () => { shutdown().catch(error => console.error('Monitoring shutdown failed:', error.message)); });
  if (c.handleSignals) {
    // A process stopped by a signal never reaches beforeExit, so the last batch of spans/logs and up to one metric
    // interval would be lost. Flush (at most 2 s), then: if the app has its own handler for the signal, leave the exit
    // to it; otherwise re-raise the signal so the process exits exactly as it would without Monitoring.
    for (const sig of ['SIGTERM', 'SIGINT']) {
      const onSignal = () => {
        const appHandles = process.listenerCount(sig) > 0;
        const timeout = new Promise(r => setTimeout(r, 2000).unref());
        Promise.race([shutdown().catch(() => {}), timeout]).finally(() => { if (!appHandles) process.kill(process.pid, sig); });
      };
      process.once(sig, onSignal);
    }
  }
  return module.exports;
}

async function forceFlush() {
  if (!sdk) return;
  // Providers expose forceFlush in OTel; flush all signals without disabling them.
  await Promise.all([sdk._tracerProvider, sdk._meterProvider, sdk._loggerProvider]
    .filter(Boolean).map(provider => provider.forceFlush()));
}
function shutdown() {
  // Installed NodeSDK owns the metric reader's graceful final collect/flush and
  // exporter shutdown. Do not shutdown the exporter first and discard that
  // collection. All HTTP calls remain bounded; no fallback or DATA replay.
  if (shutdownPromise) return shutdownPromise;
  clearInterval(timer);
  loopDelay?.disable();
  shutdownPromise = normalCustodySelection?.normalCustodyShutdown && sdk ?
    require('./lib/normal-custody-barrier').coordinatedShutdown(sdk,normalCustodyDelivery,normalCustodySelection) :
    (sdk ? sdk.shutdown() : Promise.resolve());
  return shutdownPromise;
}
module.exports = { init, tracer, metrics, forceFlush, shutdown, normalCustodyDelivery: { summary:()=>normalCustodyDelivery?.summary()||null,snapshot:()=>normalCustodyDelivery?.snapshot()||[],recover:async(id)=>{if(!normalCustodyDelivery)throw Error('Normal custody disabled');return normalCustodyDelivery.recover(id);} }, candidateMetricDelivery: { summary:()=>candidateAppDelivery?.summary()||null,snapshot:()=>candidateAppDelivery?.snapshot()||[],recover:async(id)=>{if(!candidateAppDelivery)throw Error('Candidate metrics disabled');return candidateAppDelivery.recover(id);} }, metricDelivery: { summary:()=>directMetricDelivery?.summary()||null,snapshot:()=>directMetricDelivery?.snapshot()||[],recover:async(id)=>{if(!directMetricDelivery)throw Error('Experimental direct metric delivery is not enabled');return directMetricDelivery.recover(id);} } };
