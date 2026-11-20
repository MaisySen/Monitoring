import os
"""Monitoring telemetry: init(), tracer.trace(), and tagged custom metrics."""
import atexit
import logging
import threading
from importlib.metadata import entry_points

from . import metrics, tracer
from .config import configuration

__version__ = "0.1.0"
_providers = None
_lock = threading.RLock()
_handler = None
_previous_factory = None
_initialized = False


def init(_instrument=True, **options):
    # Flush spans and logs every 500 ms (the OTel default is 5 s) so data shows up in Monitoring quickly.
    os.environ.setdefault("OTEL_BSP_SCHEDULE_DELAY", "500")
    os.environ.setdefault("OTEL_BLRP_SCHEDULE_DELAY", "500")
    # A bigger queue avoids dropping spans under bursts.
    os.environ.setdefault("OTEL_BSP_MAX_QUEUE_SIZE", "16384")
    """Configure all telemetry providers once, before importing frameworks."""
    global _providers, _handler, _previous_factory, _initialized
    with _lock:
        if _initialized:
            return
        c = configuration(options)
        from opentelemetry import trace, metrics as otel_metrics, _logs
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import AggregationTemporality, PeriodicExportingMetricReader
        from opentelemetry.sdk.metrics._internal.instrument import Counter, Histogram, ObservableCounter
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

        resource = Resource.create(c["attributes"])
        sampler = ParentBased(TraceIdRatioBased(c["sample_rate"])) if c["sample_rate_override"] else None
        span_provider = TracerProvider(resource=resource, sampler=sampler)
        if os.environ.get("MONITORING_EXPORTER", "monitoring") == "otel":
            span_exporter = OTLPSpanExporter(endpoint=c["endpoints"]["traces"], headers=c["headers"])
        else:
            # Monitoring's direct OTLP encoder: shorter GIL holds in the export thread, lower tail latency.
            from ._span_exporter import MonitoringSpanExporter
            span_exporter = MonitoringSpanExporter(c["endpoints"]["traces"], headers=c["headers"])
        span_provider.add_span_processor(BatchSpanProcessor(span_exporter))
        metric_exporter = OTLPMetricExporter(
            endpoint=c["endpoints"]["metrics"], headers=c["headers"],
            preferred_temporality={Counter: AggregationTemporality.DELTA,
                                   Histogram: AggregationTemporality.DELTA,
                                   ObservableCounter: AggregationTemporality.DELTA},
        )
        metric_provider = MeterProvider(resource=resource, metric_readers=[
            PeriodicExportingMetricReader(metric_exporter, export_interval_millis=c["metric_interval"])
        ])
        logger_provider = LoggerProvider(resource=resource)
        if c["log_shipping"]:
            logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(
                endpoint=c["endpoints"]["logs"], headers=c["headers"])))
        trace.set_tracer_provider(span_provider)
        otel_metrics.set_meter_provider(metric_provider)
        _logs.set_logger_provider(logger_provider)
        _handler = LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)
        if c["log_shipping"]:
            logging.getLogger().addHandler(_handler)
            _keep_basic_config_working()
        if c["logs_injection"]:
            # Install before the logging instrumentor so native and Monitoring IDs coexist.
            _previous_factory = logging.getLogRecordFactory()
            previous = _previous_factory

            def factory(*args, **kwargs):
                record = previous(*args, **kwargs)
                context = trace.get_current_span().get_span_context()
                record.trace_id = record.otelTraceID = format(context.trace_id, "032x")
                record.span_id = record.otelSpanID = format(context.span_id, "016x")
                record.otelTraceSampled = context.trace_flags.sampled
                record.otelServiceName = c["attributes"]["service.name"]
                return record

            logging.setLogRecordFactory(factory)
        _providers = (span_provider, metric_provider, logger_provider)
        if c["handle_signals"]:
            _flush_on_sigterm()
        _initialized = True
        atexit.register(shutdown)
        from ._dbapi import patch_connection_shortcuts, patch_commit
        patch_connection_shortcuts()
        if c.get("trace_db_commit"):
            patch_commit()
        if c["runtime_metrics"]:
            import gc
            from opentelemetry.metrics import Observation
            meter = otel_metrics.get_meter("monitoring.runtime", __version__)
            meter.create_observable_gauge("runtime.python.gc.objects",
                                          callbacks=[lambda _: [Observation(len(gc.get_objects()))]])
        if _instrument:
            from opentelemetry.instrumentation.dependencies import get_dist_dependency_conflicts
            disabled = set(__import__("os").environ.get("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", "").split(","))
            # Lean Flask server spans replace OpenTelemetry's Flask instrumentation (MONITORING_FAST_FLASK=false to undo).
            if c["fast_flask"] and "flask" not in disabled:
                from ._fast_flask import patch_flask
                if patch_flask():
                    disabled.add("flask")
            # Request-duration metrics from instrumentations are off by default: Monitoring derives request counts,
            # errors and latency from spans at ingest (MONITORING_HTTP_METRICS=true to also record them in the app).
            instrument_kwargs = {}
            if not c["http_metrics"]:
                from opentelemetry.metrics import NoOpMeterProvider
                instrument_kwargs["meter_provider"] = NoOpMeterProvider()
            for entry in entry_points(group="opentelemetry_instrumentor"):
                # Logging is handled above so toggling injection never disables shipping.
                if "*" in disabled or entry.name in disabled or entry.name == "logging":
                    continue
                if get_dist_dependency_conflicts(entry.dist):
                    continue
                instrumentor = entry.load()()
                if not instrumentor.is_instrumented_by_opentelemetry:
                    instrumentor.instrument(**instrument_kwargs)


def _keep_basic_config_working():
    """logging.basicConfig() does nothing when the root logger already has a handler, so Monitoring's shipping handler
    would silently swallow the app's own basicConfig(level=..., filename=...). Hide it while basicConfig runs."""
    if getattr(logging.basicConfig, "_monitoring", False):
        return
    original = logging.basicConfig

    def basicConfig(**kwargs):
        root = logging.getLogger()
        attached = _handler is not None and _handler in root.handlers
        if attached:
            root.removeHandler(_handler)
        try:
            return original(**kwargs)
        finally:
            if attached and _handler not in root.handlers:
                root.addHandler(_handler)

    basicConfig._monitoring = True
    logging.basicConfig = basicConfig


def _flush_on_sigterm():
    """Python's default SIGTERM handling exits without running atexit, losing buffered telemetry. If the app has not
    installed its own SIGTERM handler, flush and then exit exactly as the default would (re-raise with SIG_DFL)."""
    import os
    import signal
    import threading
    if threading.current_thread() is not threading.main_thread():
        return
    if signal.getsignal(signal.SIGTERM) not in (signal.SIG_DFL, None):
        return

    def on_sigterm(signum, frame):
        try:
            shutdown()
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            os.kill(os.getpid(), signal.SIGTERM)

    signal.signal(signal.SIGTERM, on_sigterm)


def force_flush(timeout_millis=30000):
    """Flush all three signals, returning False if any provider times out."""
    if _providers is None:
        return True
    return all([p.force_flush(timeout_millis) for p in _providers])


def shutdown():
    """Drain and stop providers; call before process termination."""
    global _providers
    with _lock:
        if _providers is None:
            return
        providers, _providers = _providers, None
        if _handler is not None:
            logging.getLogger().removeHandler(_handler)
        for provider in providers:
            provider.shutdown()
