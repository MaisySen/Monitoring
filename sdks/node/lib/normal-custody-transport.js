"use strict";
const http = require("node:http"),
  https = require("node:https"),
  wire = require("./normal-custody-wire");
// Transport validates framing/raw JSON before exposing parsed objects. No retry,
// redirect, cookies, compression, arbitrary path/headers or environment proxy.
function request(origin, key, path, body, signal, testing = {}) {
  return new Promise((resolve, reject) => {
    let bytes,
      max = wire.CONTROL_BYTES;
    const get = path === "/capabilities" || path === "/status";
    if (!["/capabilities", "/status", "/lease", "/metrics", "/receipt", "/recover", "/barrier"].includes(path))
      return reject(Error("Normal custody transport unavailable"));
    try {
      if (wire.destination(origin) !== origin || typeof key !== "string" || !/^[a-fA-F0-9]{32,64}$/.test(key)) wire.fail();
      if (get) {
        if (body !== undefined) wire.fail();
        if (path === "/status") max = wire.STATUS_BYTES;
      } else if (path === "/metrics") {
        if (
          !Buffer.isBuffer(body?.bytes) ||
          !body.bytes.length ||
          body.bytes.length > 1048576 ||
          !/^[a-f0-9]{32}$/.test(body.id) ||
          !/^[a-f0-9]{32}$/.test(body.epoch)
        )
          wire.fail();
        bytes = body.bytes;
      } else {
        bytes = Buffer.from(JSON.stringify(body));
        if (!bytes.length || bytes.length > 4096) wire.fail();
      }
    } catch {
      return reject(Error("Normal custody transport unavailable"));
    }
    const headers = { "DC-API-KEY": key };
    if (bytes) {
      headers["Content-Type"] = path === "/metrics" ? "application/x-protobuf" : "application/json";
      headers["Content-Length"] = bytes.length;
    }
    if (path === "/metrics") {
      headers["X-Monitoring-Input-ID"] = body.id;
      headers["X-Monitoring-Agent-Epoch"] = body.epoch;
    }
    let done = false,
      req,
      res,
      timer;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        req?.destroy();
        res?.destroy();
        reject(Error("Normal custody transport unavailable"));
      } else resolve(result);
    };
    const abort = () => finish(true);
    if (signal?.aborted) return finish(true);
    try {
      req = (testing.request || (origin.startsWith("https:") ? https.request : http.request))(
        new URL(wire.PREFIX + path, origin),
        { method: get ? "GET" : "POST", headers, agent: false, maxHeaderSize: 8192 },
        (r) => {
          res = r;
          // Count raw headers, since Node joins/discards some duplicate headers.
          const count = (k) => {
            let n = 0;
            for (let i = 0; i < r.rawHeaders.length; i += 2) if (r.rawHeaders[i].toLowerCase() === k) n++;
            return n;
          };
          if (
            r.statusCode !== 200 ||
            r.rawHeaders.length > 128 ||
            count("transfer-encoding") > 1 ||
            (count("transfer-encoding") === 1 && (r.headers["transfer-encoding"] !== "chunked" || count("content-length") !== 0)) ||
            count("content-type") !== 1 ||
            count("cache-control") !== 1 ||
            count("content-length") > 1 ||
            count("content-encoding") !== 0 ||
            r.headers["content-type"] !== "application/json" ||
            r.headers["cache-control"] !== "no-store"
          )
            return finish(true);
          const len = r.headers["content-length"];
          if (len !== undefined && (!/^(0|[1-9][0-9]*)$/.test(len) || !Number.isSafeInteger(Number(len)) || Number(len) > max)) return finish(true);
          const chunks = [];
          let n = 0;
          r.on("data", (b) => {
            if (done) return;
            n += b.length;
            if (n > max) return finish(true);
            chunks.push(b);
          });
          r.on("error", () => finish(true));
          r.on("aborted", () => finish(true));
          r.on("end", () => {
            if (done) return;
            try {
              if (!r.complete || (len !== undefined && n !== Number(len))) wire.fail();
              finish(false, { status: 200, body: wire.parse(Buffer.concat(chunks), max) });
            } catch {
              finish(true);
            }
          });
        },
      );
      req.maxHeadersCount = 64;
      req.on("error", () => finish(true));
      timer = setTimeout(abort, 5000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      req.end(bytes);
    } catch {
      finish(true);
    }
  });
}
module.exports = { request };
