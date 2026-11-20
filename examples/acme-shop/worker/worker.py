import json, logging, os, random, time, requests
LOG_DIR = os.environ.get("ACME_LOG_DIR", "/tmp/acme-shop")
from monitoring import tracer, metrics   # started by: monitoring-run python worker.py

class JsonFormatter(logging.Formatter):
    def format(self, r):
        d = {"timestamp": self.formatTime(r), "level": r.levelname.lower(), "message": r.getMessage(), "service": "order-worker"}
        for k in ("trace_id", "span_id"):
            if hasattr(r, k): d[k] = getattr(r, k)
        return json.dumps(d)
os.makedirs(LOG_DIR, exist_ok=True)
h = logging.FileHandler(os.path.join(LOG_DIR, "order-worker.log")); h.setFormatter(JsonFormatter())
log = logging.getLogger("worker"); log.setLevel(logging.INFO); log.addHandler(h)

while True:
    with tracer.trace("fulfillment.batch", resource="process_pending_orders"):
        pending = requests.get("http://127.0.0.1:4102/orders/pending").json()["orders"]
        metrics.gauge("acme.queue.depth", len(pending))
        for o in pending[: random.randint(1, 6)]:
            t0 = time.time()
            with tracer.trace("fulfillment.ship_order", resource="ship_order"):
                time.sleep(random.uniform(0.05, 0.25))
                requests.post(f"http://127.0.0.1:4102/orders/{o['id']}/fulfill")
            metrics.increment("acme.orders.fulfilled")
            metrics.histogram("acme.fulfillment.duration", time.time() - t0)
            log.info("shipped order %s ($%.2f)", o["id"], o["total_cents"] / 100)
        if len(pending) > 15: log.warning("fulfillment backlog: %s orders waiting", len(pending))
    time.sleep(3)
