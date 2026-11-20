# Known-behaviour Python service: one SQLite query and one log line per request (monitoring-run, through the Monitoring Agent).
import logging, os, sqlite3
from flask import Flask, jsonify, request
from opentelemetry import trace
logging.basicConfig(level=logging.INFO, filename=os.path.join(os.environ.get("TRUTH_LOG_DIR", "/tmp"), "truth-lookup.log"))
logging.getLogger("werkzeug").setLevel(logging.WARNING)
log = logging.getLogger("truth-lookup")
DB = os.environ.get("TRUTH_SQLITE", "/tmp/monitoring-truth.db")
_con = sqlite3.connect(DB)
_con.execute("create table if not exists products (id integer primary key, price_cents int)")
_con.executemany("insert or ignore into products values (?, ?)", [(i, 500 + i * 7 % 5000) for i in range(1, 1001)])
_con.commit(); _con.close()
app = Flask(__name__)
@app.get("/lookup")
def lookup():
    con = sqlite3.connect(DB)
    row = con.execute("select id, price_cents from products where id = ?", (int(request.args.get("rid", "1")) % 1000 + 1,)).fetchone()
    con.close()
    log.info("lookup rid=%s", request.args.get("rid"))
    resp = jsonify({"id": row[0], "price_cents": row[1]})
    resp.headers["x-trace-id"] = format(trace.get_current_span().get_span_context().trace_id, "032x")
    return resp
@app.get("/health")
def health(): return jsonify(ok=True)
if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5301, threaded=True)
