"""Context-manager tracing API; spans are native OpenTelemetry spans."""
from opentelemetry import trace as otel_trace
from .config import tags as attributes


def trace(name, resource=None, tags=None):
    attrs = attributes(tags)
    if resource is not None:
        attrs["resource.name"] = resource
    return otel_trace.get_tracer("monitoring", "0.1.0").start_as_current_span(name, attributes=attrs)
