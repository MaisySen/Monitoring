"""Verify OTLP protobuf signals locally, or run the example agentless."""
import gzip
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest

requests = {"traces": [], "metrics": [], "logs": []}
remote = os.environ.get("MONITORING_VERIFY_REMOTE") == "true"


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        signal = self.path.rsplit("/", 1)[-1]
        if (self.headers.get("DC-API-KEY") != "local-verification-only"
                or self.headers.get("Content-Type") != "application/x-protobuf"
                or signal not in requests):
            self.send_error(400)
            return
        data = self.rfile.read(int(self.headers["Content-Length"]))
        if self.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        message = {"traces": ExportTraceServiceRequest,
                   "metrics": ExportMetricsServiceRequest,
                   "logs": ExportLogsServiceRequest}[signal]()
        message.ParseFromString(data)
        requests[signal].append(message)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_):
        pass


def main():
    sink, worker, child = None, None, None
    try:
        env = {**os.environ, "MONITORING_SERVICE": "monitoring-python-verify",
               "MONITORING_ENV": "verification", "PORT": "18082"}
        if not remote:
            sink = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
            worker = threading.Thread(target=sink.serve_forever, daemon=True)
            worker.start()
            env.update(MONITORING_URL=f"http://127.0.0.1:{sink.server_port}",
                       MONITORING_API_KEY="local-verification-only")
        else:
            assert env.get("MONITORING_URL") and env.get("MONITORING_API_KEY"), "Remote verification requires URL and key"
        root = Path(__file__).resolve().parent.parent
        child = subprocess.Popen([
            str(Path(sys.executable).parent / "monitoring-run"), sys.executable, "examples/app.py",
        ], env=env, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        ready = False
        for _ in range(100):
            if child.poll() is not None:
                raise RuntimeError("Example exited early: " + child.stdout.read().decode())
            try:
                with urlopen("http://127.0.0.1:18082/work", timeout=1) as response:
                    assert response.status == 200
                    response.read()
                    ready = True
                    break
            except OSError:
                time.sleep(.1)
        assert ready, "Example did not become ready"
        child.terminate()
        output = child.communicate(timeout=30)[0].decode()
        assert child.returncode == 0, output
        if remote:
            print("Monitoring Python example completed; query service=monitoring-python-verify and metric=monitoring.example.python.requests.")
            return
        spans = [span for req in requests["traces"] for rs in req.resource_spans
                 for ss in rs.scope_spans for span in ss.spans]
        logs = [record for req in requests["logs"] for rl in req.resource_logs
                for sl in rl.scope_logs for record in sl.log_records]
        metrics = [metric for req in requests["metrics"] for rm in req.resource_metrics
                   for sm in rm.scope_metrics for metric in sm.metrics]
        custom = next(s for s in spans if s.name == "example.work")
        assert any(s.kind == 2 for s in spans), "Missing HTTP server span"
        log = next(record for record in logs if record.trace_id == custom.trace_id
                   and record.span_id == custom.span_id)
        attrs = {item.key: item.value.string_value for item in log.attributes}
        assert attrs["otelTraceID"] == custom.trace_id.hex()
        assert attrs["trace_id"] == custom.trace_id.hex()
        counter = next(m for m in metrics if m.name == "monitoring.example.python.requests")
        histogram = next(m for m in metrics if m.name == "monitoring.example.python.duration")
        assert counter.sum.aggregation_temporality == 1, "Counter is not DELTA"
        assert histogram.histogram.aggregation_temporality == 1, "Histogram is not DELTA"
        assert counter.sum.data_points[0].as_int == 1
        print({"verified": "python", "spans": len(spans), "correlatedLogs": len(logs),
               "metrics": len(metrics), "temporality": "DELTA"})
    finally:
        if child and child.poll() is None:
            child.kill()
            child.wait()
        if sink:
            sink.shutdown()
            sink.server_close()
            worker.join()


if __name__ == "__main__":
    main()
