"""Entry points consumed by opentelemetry-instrument."""
from opentelemetry.instrumentation.distro import BaseDistro
from opentelemetry.sdk._configuration import _BaseConfigurator


class MonitoringDistro(BaseDistro):
    def _configure(self, **kwargs):
        # Providers are installed by the Monitoring configurator, not the default one.
        pass

    def load_instrumentor(self, entry_point, **kwargs):
        # Monitoring configures logging once; the upstream instrumentor may otherwise
        # create a second OTLP handler or override the injection setting.
        if entry_point.name == "logging":
            return
        from .config import configuration
        c = configuration()
        # Lean Flask server spans replace OpenTelemetry's Flask instrumentation (MONITORING_FAST_FLASK=false to undo).
        if entry_point.name == "flask" and c["fast_flask"]:
            from ._fast_flask import patch_flask
            if patch_flask():
                return
        # Request-duration metrics from instrumentations are off by default: Monitoring derives request counts, errors
        # and latency from spans at ingest (MONITORING_HTTP_METRICS=true to also record them in the app).
        if not c["http_metrics"] and "meter_provider" not in kwargs:
            from opentelemetry.metrics import NoOpMeterProvider
            kwargs["meter_provider"] = NoOpMeterProvider()
        super().load_instrumentor(entry_point, **kwargs)


class MonitoringConfigurator(_BaseConfigurator):
    def _configure(self, **kwargs):
        from . import init
        init(_instrument=False)
