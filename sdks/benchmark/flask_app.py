"""Intentionally identical request handler in each instrumentation mode."""
import os
import signal
import logging
from flask import Flask

app = Flask(__name__)
logging.getLogger("werkzeug").disabled = True


@app.get("/")
def index():
    return "ok"


def stop(*_):
    if os.environ.get("BENCH_MODE") == "monitoring":
        import monitoring
        monitoring.shutdown()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
app.run(host="127.0.0.1", port=int(os.environ["PORT"]), use_reloader=False, threaded=True)
