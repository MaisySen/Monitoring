import { preflightStrictMetricEnvelope } from "../lib/strictMetricEnvelope";
import { custodyReportsEnabled, saveCustodyReport, custodyReports } from "../lib/agentCustodyReports";
import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import { raw } from "../intake/routes";
import { orgForApiKey } from "../lib/org";
import { requireOrg } from "../middlewares/authMiddleware";
import { decodeOtlp, otlpToMetrics, encodeEmptyResponse } from "../intake/otlp";
import { writeMetrics } from "../intake/store";
import {
  strictEnabled,
  strictBootstrap,
  issueStrictLease,
  strictLease,
  strictReceipt,
  strictStatus,
  recordStrictDiagnostic,
  strictDiagnostics,
  strictLosses,
  StrictDeliveryError,
  STRICT_TTL,
  STRICT_GRACE,
} from "../lib/strictMetricDelivery";

export const strictIntake = Router(),
  strictUi = Router();
const prefix = "/otlp/experimental/metric-delivery/v1";
const run = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((e) => {
    if (res.headersSent) return;
    if (e instanceof StrictDeliveryError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    if (e?.quotaReason) {
      res.status(429).json({ error: "Metric quota refused the batch; no points accepted" });
      return;
    }
    res.status(503).json({ error: "Metric delivery is temporarily unconfirmed; check receipt before retrying" });
  });
};
async function enabled(_req: Request, res: Response, next: NextFunction) {
  if (!strictEnabled()) {
    res.status(404).json({ error: "Experimental metric delivery unavailable" });
    return;
  }
  next();
}
async function ingestAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.get("DC-API-KEY");
  const org = key ? await orgForApiKey(key) : null;
  if (!org) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  req.orgId = org;
  next();
}
strictIntake.use(prefix, enabled, (req, res, next) => {
  ingestAuth(req, res, () => {
    strictBootstrap().then(
      () => next(),
      () => res.status(503).json({ error: "Experimental delivery initialization unavailable" }),
    );
  }).catch(() => res.status(503).json({ error: "Authentication unavailable" }));
});
strictIntake.get(
  prefix + "/capabilities",
  run(async (_req, res) => {
    res.json({
      protocol: "monitoring-node-direct-test-v1",
      testOnly: true,
      storage: "postgres",
      leaseMs: STRICT_TTL,
      receiptGraceMs: STRICT_GRACE,
      types: ["delta-sum", "gauge"],
      durability: "synchronous transaction verified per receipt",
      localSpool: false,
    });
  }),
);
strictIntake.post(
  prefix + "/lease",
  raw,
  run(async (req, res) => {
    if (req.body.length > 1024) throw new StrictDeliveryError(413, "Lease request too large");
    let b: any;
    try {
      b = JSON.parse(req.body.toString());
    } catch {
      throw new StrictDeliveryError(400, "Invalid lease request");
    }
    res.json(await issueStrictLease(req.orgId!, b.sha));
  }),
);
strictIntake.post(
  prefix + "/receipt",
  raw,
  run(async (req, res) => {
    if (req.body.length > 4096) throw new StrictDeliveryError(413, "Receipt request too large");
    let b: any;
    try {
      b = JSON.parse(req.body.toString());
    } catch {
      throw new StrictDeliveryError(400, "Invalid receipt request");
    }
    if (typeof b.token !== "string") throw new StrictDeliveryError(400, "Delivery token required");
    res.json(await strictReceipt(req.orgId!, b.token));
  }),
);
strictIntake.post(
  prefix + "/metrics",
  raw,
  run(async (req, res) => {
    const bytes: Buffer = req.body;
    if (bytes.length > 1024 * 1024) throw new StrictDeliveryError(413, "Experimental metric body limit1MiB");
    if (req.get("content-encoding")) throw new StrictDeliveryError(415, "This experimental path requires uncompressed immutable protobuf");
    const ct = req.get("content-type") || "";
    if (ct !== "application/x-protobuf") throw new StrictDeliveryError(415, "Protobuf metrics required");
    const token = req.get("x-monitoring-delivery-token");
    if (!token) throw new StrictDeliveryError(400, "Strict delivery token required");
    const lease = strictLease(token);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (lease.org !== req.orgId || lease.sha !== sha) throw new StrictDeliveryError(409, "Delivery identity/body mismatch");
    preflightStrictMetricEnvelope(bytes);
    let body: any;
    try {
      body = decodeOtlp("metrics", bytes, ct);
    } catch {
      throw new StrictDeliveryError(400, "Invalid metric protobuf");
    }
    let n = 0;
    for (const rm of body.resourceMetrics ?? [])
      for (const sm of rm.scopeMetrics ?? [])
        for (const m of sm.metrics ?? []) {
          if (m.histogram || m.exponentialHistogram || m.summary || (!m.sum && !m.gauge) || (m.sum && Number(m.sum.aggregationTemporality) !== 1))
            throw new StrictDeliveryError(422, "Only DELTA sums and gauges are supported");
          for (const dp of (m.sum ?? m.gauge).dataPoints ?? []) {
            if (!Number.isFinite(Number(dp.asDouble ?? dp.asInt)) || !dp.timeUnixNano)
              throw new StrictDeliveryError(422, "Finite numeric values and timestamps required");
            n++;
          }
        }
    if (n > 1000) throw new StrictDeliveryError(413, "Experimental batch limit1000 points");
    if (!n) throw new StrictDeliveryError(422, "At least one supported data point is required");
    const decoded = otlpToMetrics(req.orgId!, body);
    if (decoded.points.length !== n) throw new StrictDeliveryError(422, "Strict batch conversion must preserve every data point");
    await writeMetrics(req.orgId!, decoded.points, { id: lease.id, sha256: sha, strictToken: token, strictBytes: bytes.length });
    decoded.commit();
    const ack = encodeEmptyResponse(ct);
    res.status(200).type(ack.type).send(ack.body);
  }),
);
strictIntake.post(
  prefix + "/diagnostic",
  raw,
  run(async (req, res) => {
    if (req.body.length > 4096) throw new StrictDeliveryError(413, "Diagnostic limit");
    let b: any;
    try {
      b = JSON.parse(req.body.toString());
    } catch {
      throw new StrictDeliveryError(400, "Invalid diagnostic");
    }
    if (typeof b.token !== "string") throw new StrictDeliveryError(400, "Token required");
    await recordStrictDiagnostic(req.orgId!, b.token, b);
    res.json({ ok: true });
  }),
);
strictIntake.post(
  prefix + "/agent-status",
  raw,
  run(async (req, res) => {
    if (!custodyReportsEnabled()) throw new StrictDeliveryError(404, "Agent reporting disabled");
    if (req.body.length > 65536) throw new StrictDeliveryError(413, "Snapshot too large");
    let b;
    try {
      b = JSON.parse(req.body.toString());
    } catch {
      throw new StrictDeliveryError(400, "Invalid snapshot");
    }
    await saveCustodyReport(req.orgId!, b);
    res.json({ ok: true });
  }),
);
strictUi.get(
  "/ui/agent-custody",
  requireOrg,
  run(async (req, res) => {
    if (!custodyReportsEnabled()) {
      res.json({ enabled: false });
      return;
    }
    res.json({ enabled: true, testOnly: true, reports: await custodyReports(req.orgId!) });
  }),
);
strictUi.get(
  "/ui/metric-delivery",
  requireOrg,
  run(async (req, res) => {
    if (!strictEnabled()) {
      res.json({ enabled: false });
      return;
    }
    res.json({
      enabled: true,
      testOnly: true,
      localSpool: false,
      losses: await strictLosses(req.orgId!),
      receipts: await strictStatus(req.orgId!),
      diagnostics: await strictDiagnostics(req.orgId!),
      warning:
        "Direct SDK measurements are not locally spooled. Process exit/offline windows can lose unconfirmed data. Legacy agent delta delivery remains unsafe under response loss.",
    });
  }),
);
