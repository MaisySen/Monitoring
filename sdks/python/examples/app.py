"""Run with monitoring-run python examples/app.py, then GET /work."""
import logging
import os
from flask import Flask
from monitoring import tracer, metrics, shutdown

logging.basicConfig(level=logging.INFO)
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("monitoring.example")
app = Flask(__name__)


@app.get("/work")
def work():
    with tracer.trace("example.work", resource="example", tags={"component": "example"}):
        metrics.increment("monitoring.example.python.requests", tags={"route": "work"})
        metrics.gauge("monitoring.example.python.queue", 2)
        metrics.histogram("monitoring.example.python.duration", 12)
        logger.info("Monitoring Python example request")
    return {"ok": True}


if __name__ == "__main__":
    import signal
    def stop(*_):
        shutdown()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8082")), use_reloader=False)
