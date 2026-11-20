"""Python twin of gen.js: RATE spans/s with attribute seq=N, plus a log line for every second span (run with monitoring-run)."""
import json, logging, os, time
from opentelemetry import trace
logging.basicConfig(level=logging.INFO, handlers=[logging.NullHandler()])
log = logging.getLogger("gen")
tracer = trace.get_tracer("gen")
RATE, SECONDS = int(os.environ.get("RATE", "200")), int(os.environ.get("SECONDS", "90"))
total, seq, logs, t0 = RATE * SECONDS, 0, 0, time.monotonic()
while seq < total:
    due = min(total, int((time.monotonic() - t0) * RATE))
    while seq < due:
        with tracer.start_as_current_span("seq.op") as span:
            span.set_attribute("seq", seq)
            if seq % 2 == 0:
                log.info("seq", extra={"seq": seq}); logs += 1
        seq += 1
    time.sleep(0.02)
print(json.dumps({"spans": seq, "logs": logs}), flush=True)
