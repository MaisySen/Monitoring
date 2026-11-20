"""Launch application instrumentation using Monitoring's OTel entry points."""
import os


def run():
    os.environ["OTEL_PYTHON_DISTRO"] = "monitoring"
    os.environ["OTEL_PYTHON_CONFIGURATOR"] = "monitoring"
    from opentelemetry.instrumentation.auto_instrumentation import run as instrument
    return instrument()


def bootstrap():
    # Install instrumentors, not application frameworks or database drivers. OpenTelemetry's bootstrap picks
    # instrumentors for the libraries already installed. Its module has no __main__ block, so `python -m` would exit
    # without doing anything; call its entry point directly (it reads -a/--action from sys.argv).
    from opentelemetry.instrumentation.bootstrap import run as otel_bootstrap

    otel_bootstrap()
