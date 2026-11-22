// Candidate normal-direct conversion contract only. NOT registered on any intake route.
// Decoded-object validation is not wire completeness validation: protobuf decoding can
// discard unknown fields or repeated singular values. A future protocol still needs
// raw-envelope/type admission before it may use this helper as part of acceptance.
import { otlpToMetrics } from "../intake/otlp";

import { deltaHistogramDistribution } from "../intake/histogramDistribution";
export const NORMAL_APP_CONTRACT = "node-app-representation-v2-candidate";
export class NormalAppShapeError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "NormalAppShapeError"; }
}
export type NormalAppAccounting = {
  contract: typeof NORMAL_APP_CONTRACT;
  sourcePoints: number;
  numberPoints: number;
  explicitHistogramPoints: number;
  exponentialHistogramPoints: number;
  omittedEmptyHistogramPoints: number;
  derivedRows: number;
  absentSumHistogramPoints: number;
  absentDistributionHistogramPoints: number;
  cumulativeSnapshotPoints: number;
};
const fail = (reason: string): never => { throw new NormalAppShapeError(reason); };
const own = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const obj = (o: any): any => o && typeof o === "object" && !Array.isArray(o) ? o : fail("Expected metric object");
const list = (a: any): any[] => a === undefined ? [] : Array.isArray(a) ? a : fail("Expected metric array");
function finite(n: any): number {
  // Do not coerce absent, null, boolean or string doubles into measurements.
  return typeof n === "number" && Number.isFinite(n) ? n : fail("Finite numeric measurement required");
}
function integer(n: any, unsigned = true): number {
  const v = typeof n === "string" && /^-?(0|[1-9][0-9]*)$/.test(n) ? Number(n) : n;
  return typeof v === "number" && Number.isSafeInteger(v) && (!unsigned || v >= 0) ? v : fail("Safe metric integer required");
}
function time(n: any): bigint {
  // Existing conversion rounds nanos to whole seconds and replaces zero seconds
  // with wall time. Refuse that substitution instead of promising immutable output.
  if (typeof n !== "string" || !/^[0-9]+$/.test(n)) return fail("String nanosecond timestamp required");
  const v = BigInt(n);
  if (v < 1000000000n || v > 18446744073709551615n) return fail("Representable nonzero-second timestamp required");
  return v;
}
function numeric(dp: any): void {
  if (Number(own(dp, "asDouble")) + Number(own(dp, "asInt")) !== 1) fail("One metric number value required");
  if (own(dp, "asDouble")) finite(dp.asDouble); else integer(dp.asInt, false);
}
function histogram(dp: any, exponential: boolean) {
  const count = integer(dp.count === undefined ? 0 : dp.count);
  if (own(dp, "sum")) {
    finite(dp.sum);
    if (!count && dp.sum !== 0) fail("Empty histogram sum must be zero");
  }
  if (own(dp, "min")) finite(dp.min);
  if (own(dp, "max")) finite(dp.max);
  if (own(dp, "min") && own(dp, "max") && dp.min > dp.max) fail("Histogram min exceeds max");
  const distribution = deltaHistogramDistribution(dp, exponential);
  if (distribution.state === "invalid") fail(distribution.reason!);
  return { count, distribution: distribution.state, sum: own(dp, "sum") };
}

/** Pure candidate preparation. No DB, no receipts, no registration, no commit call.
 * Accounting describes the CURRENT converter's representation, not bucket/exemplar
 * retention, identity/delivery, input-wire completeness or a storage receipt.
 * DELTA app shapes and nonmonotonic cumulative gauge snapshots only.
 * Not monotonic cumulative conversion, raw bucket retention or arbitrary OTLP parity.
 */
export function prepareNormalAppMetrics(orgId: number, body: unknown) {
  const a: NormalAppAccounting = {
    contract: NORMAL_APP_CONTRACT, sourcePoints: 0, numberPoints: 0,
    explicitHistogramPoints: 0, exponentialHistogramPoints: 0,
    omittedEmptyHistogramPoints: 0, derivedRows: 0,
    absentSumHistogramPoints: 0, absentDistributionHistogramPoints: 0, cumulativeSnapshotPoints: 0,
  };
  for (const rm of list(obj(body).resourceMetrics)) {
    obj(rm);
    if (own(rm, "instrumentationLibraryMetrics")) fail("Deprecated metric scope unsupported");
    for (const sm of list(rm.scopeMetrics)) {
      obj(sm);
      if (String(sm.scope?.name ?? "").includes("hostmetrics")) fail("Hostmetrics scope is outside Node app contract");
      for (const m of list(sm.metrics)) {
        obj(m);
        if (typeof m.name !== "string" || !m.name.length) fail("Metric name required");
        const kinds = ["sum", "gauge", "histogram", "exponentialHistogram", "summary"].filter((k) => own(m, k));
        if (kinds.length !== 1 || kinds[0] === "summary") fail("One supported metric data kind required");
        const kind = kinds[0], data = obj(m[kind]);
        const cumulativeSnapshot = kind === "sum" && data.aggregationTemporality === 2 && (data.isMonotonic === undefined || data.isMonotonic === false);
        if (kind === "sum" && data.isMonotonic !== undefined && typeof data.isMonotonic !== "boolean") fail("Boolean sum isMonotonic required");
        if (kind !== "gauge" && data.aggregationTemporality !== 1 && !cumulativeSnapshot) fail("DELTA or cumulative nonmonotonic snapshot required");
        for (const dp of list(data.dataPoints)) {
          obj(dp); const end = time(dp.timeUnixNano);
          if (dp.startTimeUnixNano !== undefined) {
            const start = dp.startTimeUnixNano;
            if (typeof start !== "string" || !/^[0-9]+$/.test(start) || BigInt(start) > end) fail("Invalid metric start timestamp");
          }
          if (dp.flags !== undefined && dp.flags !== 0) fail("Flagged metric observations unsupported");
          if (kind === "sum" || kind === "gauge") { numeric(dp); a.numberPoints++; if (cumulativeSnapshot) a.cumulativeSnapshotPoints++; }
          else {
            const { count, distribution, sum } = histogram(dp, kind === "exponentialHistogram");
            if (!sum) a.absentSumHistogramPoints++;
            if (distribution === "absent") a.absentDistributionHistogramPoints++;
            if (!count) a.omittedEmptyHistogramPoints++;
            if (kind === "histogram") a.explicitHistogramPoints++; else a.exponentialHistogramPoints++;
            // A finite input can still overflow interpolation. Check the current
            // converter on this one histogram before counting its representation.
            // No cumulative references exist in these validated DELTA inputs.
            const isolated = otlpToMetrics(orgId, { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ ...m, [kind]: { ...data, dataPoints: [dp] } }] }] }] });
            const expected = count ? 1 + (sum ? 2 : 0) + (distribution === "available" ? 3 : 0) + Number(own(dp, "min")) + Number(own(dp, "max")) : 0;
            if (isolated.points.length !== expected) fail("Incomplete derived histogram representation");
          }
          a.sourcePoints++;
        }
      }
    }
  }
  const conversion = otlpToMetrics(orgId, body);
  a.derivedRows = conversion.points.reduce((n, p) => n + p.points.length, 0);
  // Each derived histogram must produce the current finite representation. Do
  // not silently accept a partial set if arithmetic overflows after validation.
  if (conversion.points.some((p) => p.points.some(([ts, value]) => !Number.isFinite(ts) || !Number.isFinite(value))))
    fail("Nonfinite derived metric output");
  return { accounting: a, conversion };
}
