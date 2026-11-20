"""Run sequential, bounded SDK overhead trials; all child processes are cleaned up.

Usage: ../python/.venv/bin/python run.py
Prints JSON lines with latency, throughput and peak sampled resident memory.
"""
import argparse
import http.client
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
DURATION = float(os.environ.get("BENCH_SECONDS", "5"))
CONNECTIONS = int(os.environ.get("BENCH_CONNECTIONS", "4"))


class Sink(BaseHTTPRequestHandler):
    # Accept and discard OTLP requests.
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        body = b"{}" if not self.path.startswith("/v0.") else b'{"rate_by_service":{}}'
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_PUT = do_POST
    do_GET = do_POST

    def log_message(self, *_):
        pass


def rss_kib(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    return 0


def request(port, connection=None):
    conn = connection or http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", "/")
    response = conn.getresponse()
    body = response.read()
    if response.status != 200 or body != b"ok":
        raise RuntimeError(f"Unexpected response {response.status}: {body!r}")
    if connection is None:
        conn.close()


def python_load(port):
    # Four closed-loop clients, matching autocannon's default concurrency.
    latencies, errors = [], []
    deadline = time.monotonic() + DURATION
    lock = threading.Lock()

    def worker():
        local = []
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            while time.monotonic() < deadline:
                started = time.perf_counter_ns()
                request(port, conn)
                local.append((time.perf_counter_ns() - started) / 1e6)
        except Exception as error:
            with lock:
                errors.append(str(error))
        finally:
            conn.close()
            with lock:
                latencies.extend(local)

    threads = [threading.Thread(target=worker) for _ in range(CONNECTIONS)]
    started = time.monotonic()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    elapsed = time.monotonic() - started
    if errors:
        raise RuntimeError(f"Load errors: {errors}")
    if not latencies:
        raise RuntimeError("No requests measured")
    latencies.sort()
    return {
        "p50_ms": round(statistics.median(latencies), 3),
        "p99_ms": round(latencies[math.ceil(len(latencies) * .99) - 1], 3),
        "requests": len(latencies), "requests_per_second": round(len(latencies) / elapsed, 2),
    }


def trial(runtime, mode, sink_port):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("MONITORING_", "OTEL_", "DD_")) and key not in ("NODE_OPTIONS", "PYTHONPATH")}
    port = 18181 if runtime == "node" else 18182
    env.update(PORT=str(port), BENCH_MODE=mode, MONITORING_SERVICE=f"benchmark-{runtime}",
               MONITORING_AGENT_URL=f"http://127.0.0.1:{sink_port}",
               DD_TRACE_AGENT_URL=f"http://127.0.0.1:{sink_port}",
               DD_SERVICE=f"benchmark-{runtime}", DD_INSTRUMENTATION_TELEMETRY_ENABLED="false",
               DD_REMOTE_CONFIGURATION_ENABLED="false", BENCH_SECONDS=str(DURATION),
               BENCH_CONNECTIONS=str(CONNECTIONS))
    # BENCHENV_X=y passes X=y to the app under test (for trying library settings)
    env.update({key[len("BENCHENV_"):]: value for key, value in os.environ.items() if key.startswith("BENCHENV_")})
    if runtime == "node":
        command = ["node"]
        if mode == "monitoring":
            command += ["-r", str(ROOT / "node/init.js")]
        command += [str(HERE / "express.js")]
    else:
        python = str(ROOT / "python/.venv/bin/python")
        if mode == "monitoring":
            command = [str(ROOT / "python/.venv/bin/monitoring-run"), python]
        else:
            command = [python]
        command += [str(HERE / "flask_app.py")]
    # Discard per-request instrumentation diagnostics to avoid pipe backpressure;
    # startup errors remain visible in a temporary file on failure.
    import tempfile
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
        samples, stop = [], threading.Event()

        def memory_sampler():
            while not stop.wait(.05):
                try:
                    samples.append(rss_kib(child.pid))
                except FileNotFoundError:
                    break

        sampler = threading.Thread(target=memory_sampler)
        try:
            for _ in range(200):
                if child.poll() is not None:
                    output.seek(0)
                    raise RuntimeError(output.read().decode())
                try:
                    request(port)
                    break
                except OSError:
                    time.sleep(.05)
            else:
                raise RuntimeError("Benchmark app failed to start")
            # Identical one-second warmup before collecting measured requests.
            until = time.monotonic() + 1
            while time.monotonic() < until:
                request(port)
            sampler.start()
            # BENCH_NODE_DRIVER=stdlib measures Node with the same microsecond-resolution closed-loop
            # clients used for Python (autocannon only reports whole milliseconds).
            if runtime == "node" and os.environ.get("BENCH_NODE_DRIVER") != "stdlib":
                result = subprocess.run(["node", str(HERE / "autocannon.js"), f"http://127.0.0.1:{port}"],
                                        env=env, text=True, capture_output=True, check=True)
                measured = json.loads(result.stdout)
                measured["driver"] = "autocannon"
            else:
                measured = python_load(port)
                measured["driver"] = "stdlib closed-loop HTTP clients"
            measured.update(runtime=runtime, mode=mode, connections=CONNECTIONS,
                            duration_s=DURATION, rss_peak_kib=max(samples, default=rss_kib(child.pid)))
            print(json.dumps(measured), flush=True)
        finally:
            stop.set()
            if sampler.ident:
                sampler.join()
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    sink = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
    worker = threading.Thread(target=sink.serve_forever, daemon=True)
    worker.start()
    try:
        runtimes = os.environ.get("BENCH_RUNTIMES", "node,python").split(",")
        modes = os.environ.get("BENCH_MODES", "baseline,monitoring").split(",")
        # BENCH_TRIALS>1 interleaves modes round-robin so drift (thermal, noisy neighbours) hits all modes equally
        for _ in range(int(os.environ.get("BENCH_TRIALS", "1"))):
            for runtime in runtimes:
                for mode in modes:
                    trial(runtime, mode, sink.server_port)
    finally:
        sink.shutdown()
        sink.server_close()
        worker.join()


if __name__ == "__main__":
    main()
