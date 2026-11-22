import { Router, type Request } from "express";
import { CandidateService, candidateConfig, CANDIDATE_PREFIX, CANDIDATE_TEST, CandidateError, candidateFailure } from "../lib/candidateAppService";
import { RAW_APP_TEST_LIMITS } from "../lib/rawAppMetrics";
export function createCandidateRouter() {
  const router = Router(),
    config = candidateConfig();
  if (!config) return { router, close: async () => {} };
  const service = new CandidateService();
  let data = 0,
    control = 0,
    buffered = 0;
  function header(req: Request, name: string, required = true) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
    const v = req.headers[name];
    if (count > 1 || (required && count !== 1) || (v !== undefined && (typeof v !== "string" || !v || v.length > 128)))
      throw new CandidateError(400, "invalid");
    return typeof v === "string" ? v : "";
  }
  router.use(CANDIDATE_PREFIX, async (req, res) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let admitted = false,
      held = 0,
      readDeadline: ReturnType<typeof setTimeout> | undefined;
    const isData = req.path === "/metrics" && req.method === "POST";
    try {
      // Candidate intentionally disallows browser origins and URL parameters.
      if (
        req.originalUrl.includes("?") ||
        req.headers.origin ||
        req.headers.cookie ||
        req.headers.authorization ||
        req.headers["dd-api-key"] ||
        req.headers["dd-application-key"]
      )
        throw new CandidateError(403, "forbidden");
      if (!((req.path === "/capabilities" && req.method === "GET") || (["/lease", "/receipt", "/metrics"].includes(req.path) && req.method === "POST")))
        throw new CandidateError(404, "unavailable");
      if (isData ? data >= CANDIDATE_TEST.dataCalls : control >= CANDIDATE_TEST.controlCalls) throw new CandidateError(429, "backpressure");
      isData ? data++ : control++;
      admitted = true;
      const key = header(req, "dc-api-key");
      if (!/^[a-fA-F0-9]{32,64}$/.test(key)) throw new CandidateError(403, "forbidden");
      const id = header(req, "x-monitoring-batch-id", isData),
        credential = header(req, "x-monitoring-delivery-credential", isData);
      if (!isData && (id || credential)) throw new CandidateError(400, "invalid");
      if (header(req, "content-encoding", false)) throw new CandidateError(415, "unsupported");
      if (req.method === "POST" && header(req, "content-type") !== (isData ? "application/x-protobuf" : "application/json"))
        throw new CandidateError(415, "unsupported");
      if (req.method === "GET" && (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) !== 0))
        throw new CandidateError(400, "invalid");
      const deadline = Date.now() + CANDIDATE_TEST.bodyMs;
      if (req.method === "POST")
        readDeadline = setTimeout(() => {
          if (!res.headersSent && !res.destroyed) {
            res.setHeader("Connection", "close");
            res.once("finish", () => req.destroy());
            res.status(408).json({ error: "request-timeout" });
          }
        }, CANDIDATE_TEST.bodyMs);
      await service.preflight(key); // short transaction only; final owner relocks.
      if (Date.now() >= deadline || req.aborted || req.destroyed) throw new CandidateError(408, "request-timeout");
      if (req.method === "GET") {
        res.json(await service.capabilities(key));
        return;
      }
      const limit = isData ? RAW_APP_TEST_LIMITS.bytes : CANDIDATE_TEST.controlBytes;
      const len = header(req, "content-length", false);
      if (len && (!/^\d+$/.test(len) || Number(len) > limit)) throw new CandidateError(413, "body-limit");
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let n = 0,
          settled = false;
        const finish = (e?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.off("data", onData);
          req.off("end", onEnd);
          req.off("aborted", onAbort);
          req.off("error", onAbort);
          if (e) {
            req.resume();
            reject(e);
          } else resolve(Buffer.concat(chunks, n));
        };
        const onData = (b: Buffer) => {
          if (n + b.length > limit || buffered + b.length > CANDIDATE_TEST.bufferedBytes) {
            finish(new CandidateError(413, "body-limit"));
            return;
          }
          n += b.length;
          buffered += b.length;
          held += b.length;
          chunks.push(b);
        };
        const onEnd = () => finish(),
          onAbort = () => finish(new CandidateError(400, "invalid"));
        const timer = setTimeout(() => finish(new CandidateError(408, "request-timeout")), Math.max(1, deadline - Date.now()));
        req.on("data", onData);
        req.on("end", onEnd);
        req.on("aborted", onAbort);
        req.on("error", onAbort);
      });
      clearTimeout(readDeadline);
      let result;
      if (isData) result = await service.accept(key, id, credential, body);
      else {
        let input;
        try {
          input = JSON.parse(body.toString("utf8"));
        } catch {
          throw new CandidateError(400, "invalid");
        }
        if (req.path === "/lease") result = await service.issue(key, input);
        else {
          if (!input || Object.keys(input).sort().join(",") !== "credential,id" || typeof input.id !== "string" || typeof input.credential !== "string")
            throw new CandidateError(400, "invalid");
          result = await service.receipt(key, input.id, input.credential);
        }
      }
      if (!res.destroyed) res.json(result);
    } catch (e) {
      const failure = candidateFailure(e);
      // Deliberate allowlist: no exception, headers, URL, key, body or credential logging.
      if (!res.headersSent && !res.destroyed) {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
        res.status(failure.status).json({ error: failure.code });
      }
      req.resume();
    } finally {
      clearTimeout(readDeadline);
      if (admitted) isData ? data-- : control--;
      buffered -= held;
    }
  });
  return { router, close: () => service.close() };
}
