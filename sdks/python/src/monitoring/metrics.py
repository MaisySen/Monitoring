"""Small tagged metrics API backed by the OpenTelemetry meter."""
from threading import Lock
from opentelemetry import metrics as otel_metrics
from .config import tags as attributes

_instruments = {}
_lock = Lock()


def _instrument(kind, name):
    with _lock:
        key = (kind, name)
        if key not in _instruments:
            meter = otel_metrics.get_meter("monitoring", "0.1.0")
            factory = {"counter": meter.create_counter, "gauge": meter.create_gauge,
                       "histogram": meter.create_histogram}[kind]
            _instruments[key] = factory(name)
        return _instruments[key]


def increment(name, value=1, tags=None):
    _instrument("counter", name).add(value, attributes(tags))


def gauge(name, value, tags=None):
    _instrument("gauge", name).set(value, attributes(tags))


def histogram(name, value, tags=None):
    _instrument("histogram", name).record(value, attributes(tags))


def distribution(name, value, tags=None):
    histogram(name, value, tags)
