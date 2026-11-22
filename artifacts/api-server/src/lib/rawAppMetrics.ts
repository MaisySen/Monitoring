// Unregistered, pure strict protobuf subset guard. No decode, rewrite, identity,
// auth, receipt or storage. Test ceilings are NOT production capacity policy.
export const RAW_APP_SUBSET = "node-app-protobuf-subset-v1-candidate";
export const RAW_APP_TEST_LIMITS = Object.freeze({
  bytes: 1048576, fields: 100000, depth: 16, messages: 10000,
  resources: 64, scopes: 256, metrics: 1024, sourcePoints: 1000,
  derivedRowsUpperBound: 8000, bucketsPerPoint: 2048, buckets: 16384,
  kvPerSet: 64, kv: 4096, attributeDepth: 8, attributeBytes: 262144,
  stringBytes: 4096, nameBytes: 256, schemaBytes: 2048,
});
export type RawAppLimits = typeof RAW_APP_TEST_LIMITS;
export class RawAppError extends Error {
  constructor(readonly code: "malformed" | "unsupported" | "limit", readonly reason: string) { super(reason); this.name = "RawAppError"; }
}
type Rule = { wire: number; child?: string; repeated?: boolean; packed?: boolean; text?: boolean; max?: "nameBytes" | "schemaBytes"; group?: string; zero?: boolean; bool?: boolean; u32?: boolean; kv?: boolean; reject?: boolean };
const msg = (child: string, repeated = false, kv = false): Rule => ({ wire: 2, child, repeated, kv });
const scalar = (wire: number, extra: Partial<Rule> = {}): Rule => ({ wire, ...extra });
const text = (max?: Rule["max"]): Rule => ({ wire: 2, text: true, max });
const vector = (wire: number): Rule => ({ wire, repeated: true, packed: true });
const noExemplar: Rule = { wire: 2, repeated: true, reject: true };
const schema: Record<string, Record<number, Rule>> = {
  Request: { 1: msg("ResourceMetrics", true) },
  ResourceMetrics: { 1: msg("Resource"), 2: msg("ScopeMetrics", true), 3: text("schemaBytes") },
  ScopeMetrics: { 1: msg("Scope"), 2: msg("Metric", true), 3: text("schemaBytes") },
  Resource: { 1: msg("KV", true, true), 2: scalar(0, { u32: true }) },
  Scope: { 1: text(), 2: text(), 3: msg("KV", true, true), 4: scalar(0, { u32: true }) },
  KV: { 1: text(), 2: msg("Any") },
  Any: { 1: { ...text(), group: "value" }, 2: scalar(0, { bool: true, group: "value" }), 3: scalar(0, { group: "value" }), 4: scalar(1, { group: "value" }), 5: { ...msg("Array"), group: "value" }, 6: { ...msg("KVList"), group: "value" }, 7: scalar(2, { group: "value" }) },
  Array: { 1: msg("Any", true) }, KVList: { 1: msg("KV", true, true) },
  Metric: { 1: text("nameBytes"), 2: text(), 3: text(), 5: { ...msg("Gauge"), group: "data" }, 7: { ...msg("Sum"), group: "data" }, 9: { ...msg("Histogram"), group: "data" }, 10: { ...msg("Exponential"), group: "data" }, 12: msg("KV", true, true) },
  Gauge: { 1: msg("NumberPoint", true) },
  Sum: { 1: msg("NumberPoint", true), 2: scalar(0), 3: scalar(0, { bool: true }) },
  Histogram: { 1: msg("HistogramPoint", true), 2: scalar(0) },
  Exponential: { 1: msg("ExponentialPoint", true), 2: scalar(0) },
  NumberPoint: { 7: msg("KV", true, true), 2: scalar(1), 3: scalar(1), 4: scalar(1, { group: "number" }), 6: scalar(1, { group: "number" }), 5: noExemplar, 8: scalar(0, { zero: true }) },
  HistogramPoint: { 9: msg("KV", true, true), 2: scalar(1), 3: scalar(1), 4: scalar(1), 5: scalar(1), 6: vector(1), 7: vector(1), 8: noExemplar, 10: scalar(0, { zero: true }), 11: scalar(1), 12: scalar(1) },
  ExponentialPoint: { 1: msg("KV", true, true), 2: scalar(1), 3: scalar(1), 4: scalar(1), 5: scalar(1), 6: scalar(0, { u32: true }), 7: scalar(1), 8: msg("Buckets"), 9: msg("Buckets"), 10: scalar(0, { zero: true }), 11: noExemplar, 12: scalar(1), 13: scalar(1), 14: scalar(1) },
  Buckets: { 1: scalar(0, { u32: true }), 2: vector(0) },
};
export type RawAppCounts = { subset: typeof RAW_APP_SUBSET; bytes: number; fields: number; messages: number; resources: number; scopes: number; metrics: number; sourcePoints: number; derivedRowsUpperBound: number; buckets: number; kv: number; attributeBytes: number };
/** This guard only approves the advertised raw subset. Caller must ALSO run v2
 * decoded representation validation, and later own auth/transaction/storage.
 * Caller-supplied test ceilings can only lower fixed engineering ceilings.
 */
export function preflightRawAppMetrics(bytes: Uint8Array, lower: Partial<Record<keyof RawAppLimits, number>> = {}): RawAppCounts {
  if (!(bytes instanceof Uint8Array)) throw new RawAppError("malformed", "Metric bytes required");
  const limits = { ...RAW_APP_TEST_LIMITS } as Record<keyof RawAppLimits, number>;
  for (const key of Object.keys(lower) as (keyof RawAppLimits)[]) {
    const n = lower[key];
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(n) || n! < 0 || n! > limits[key]) throw new RawAppError("limit", "Invalid candidate ceiling override");
    limits[key] = n!;
  }
  const counts: RawAppCounts = { subset: RAW_APP_SUBSET, bytes: bytes.length, fields: 0, messages: 0, resources: 0, scopes: 0, metrics: 0, sourcePoints: 0, derivedRowsUpperBound: 0, buckets: 0, kv: 0, attributeBytes: 0 };
  const fail = (code: RawAppError["code"], reason: string): never => { throw new RawAppError(code, reason); };
  const cap = (n: number, limit: number, reason: string) => { if (n > limit) fail("limit", reason); };
  const inc = (key: keyof Omit<RawAppCounts, "subset">, n: number, limit: number) => { cap(counts[key] + n, limit, key); counts[key] += n; };
  cap(bytes.length, limits.bytes, "bytes");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  function walk(kind: string, start: number, end: number, depth: number, attributeDepth: number, pointBudget?: { buckets: number }): string | undefined {
    cap(depth, limits.depth, "depth"); cap(attributeDepth, limits.attributeDepth, "attributeDepth");
    inc("messages", 1, limits.messages);
    if (kind === "ResourceMetrics") inc("resources", 1, limits.resources);
    if (kind === "ScopeMetrics") inc("scopes", 1, limits.scopes);
    if (kind === "Metric") inc("metrics", 1, limits.metrics);
    if (["NumberPoint", "HistogramPoint", "ExponentialPoint"].includes(kind)) {
      inc("sourcePoints", 1, limits.sourcePoints);
      inc("derivedRowsUpperBound", kind === "NumberPoint" ? 1 : 8, limits.derivedRowsUpperBound);
      pointBudget = { buckets: 0 };
    }
    let pos = start, key: string | undefined;
    const seen = new Set<number>(), groups = new Set<string>(), kvKeys = new Set<string>();
    let kvCount = 0;
    const varint = (): bigint => {
      let v = 0n;
      for (let i = 0; i < 10; i++) {
        if (pos >= end) return fail("malformed", "Truncated varint");
        const b = bytes[pos++]; if (i === 9 && b > 1) return fail("malformed", "Varint overflow");
        v |= BigInt(b & 127) << BigInt(7 * i); if (!(b & 128)) return v;
      }
      return fail("malformed", "Varint overflow");
    };
    const bucket = () => {
      if (!pointBudget) return fail("malformed", "Bucket outside point");
      cap(pointBudget.buckets + 1, limits.bucketsPerPoint, "bucketsPerPoint");
      inc("buckets", 1, limits.buckets); pointBudget.buckets++;
    };
    while (pos < end) {
      inc("fields", 1, limits.fields);
      const tag = varint();
      if (tag > 0xffffffffn) return fail("malformed", "Invalid field tag");
      const field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!field || wire === 3 || wire === 4 || wire > 5) return fail("malformed", "Invalid wire type");
      const rule = schema[kind][field];
      if (!rule || rule.reject) return fail("unsupported", "Unsupported field in " + kind);
      if (!rule.repeated && seen.has(field)) return fail("unsupported", "Repeated singular field in " + kind);
      if (rule.group && groups.has(rule.group)) return fail("unsupported", "Conflicting oneof in " + kind);
      if (wire !== rule.wire && !(rule.packed && wire === 2)) return fail("malformed", "Wrong wire type in " + kind);
      seen.add(field); if (rule.group) groups.add(rule.group);
      if (wire === 0) {
        const value = varint();
        if ((rule.zero && value !== 0n) || (rule.bool && value > 1n) || (rule.u32 && value > 0xffffffffn)) return fail("unsupported", "Unsupported scalar range");
        if (kind === "Any" && field === 3) {
          const signed = BigInt.asIntN(64, value);
          if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) return fail("unsupported", "Unsafe attribute integer");
        }
        if (rule.packed) bucket();
        continue;
      }
      if (wire === 1 || wire === 5) {
        if (end - pos < (wire === 1 ? 8 : 4)) return fail("malformed", "Truncated scalar");
        if (kind === "Any" && field === 4 && !Number.isFinite(new DataView(bytes.buffer, bytes.byteOffset + pos, 8).getFloat64(0, true))) return fail("unsupported", "Nonfinite attribute number");
        if (rule.packed) bucket(); pos += wire === 1 ? 8 : 4; continue;
      }
      const length = varint(); if (length > BigInt(end - pos)) return fail("malformed", "Truncated message");
      const next = pos + Number(length);
      if (rule.packed) {
        if (rule.wire === 1) {
          if (Number(length) % 8) return fail("malformed", "Misaligned packed vector");
          const n = Number(length) / 8;
          if (!pointBudget) return fail("malformed", "Vector outside point");
          cap(pointBudget.buckets + n, limits.bucketsPerPoint, "bucketsPerPoint");
          inc("buckets", n, limits.buckets); pointBudget.buckets += n;
          pos = next;
        } else {
          const outerEnd = end; end = next;
          while (pos < next) { bucket(); varint(); }
          end = outerEnd;
        }
      } else if (rule.child) {
        if (rule.kv) { cap(++kvCount, limits.kvPerSet, "kvPerSet"); inc("kv", 1, limits.kv); }
        // Include attribute keys and entire encoded value before parsing it.
        // Nested KV payloads are conservatively charged again, never unbounded.
        if (rule.child === "KV") inc("attributeBytes", Number(length), limits.attributeBytes);
        const childKey = walk(rule.child, pos, next, depth + 1, attributeDepth + (["Any", "Array", "KVList"].includes(rule.child) ? 1 : 0), pointBudget);
        if (rule.kv) {
          if (childKey === undefined || kvKeys.has(childKey)) return fail("unsupported", "Missing or duplicate attribute key");
          kvKeys.add(childKey);
        }
        pos = next;
      } else {
        cap(Number(length), rule.max ? limits[rule.max] : limits.stringBytes, "String or bytes length");
        if (rule.text) {
          let value: string; try { value = utf8.decode(bytes.subarray(pos, next)); } catch { return fail("malformed", "Invalid UTF8"); }
          if (kind === "KV" && field === 1) key = value;
        }
        pos = next;
      }
    }
    if (kind === "Metric" && !groups.has("data")) return fail("unsupported", "Metric data required");
    if (kind === "NumberPoint" && !groups.has("number")) return fail("unsupported", "Metric value required");
    if (kind.endsWith("Point") && !seen.has(3)) return fail("unsupported", "Timestamp required");
    if (["Sum", "Histogram", "Exponential"].includes(kind) && !seen.has(2)) return fail("unsupported", "Temporality required");
    if (kind === "Any" && !groups.has("value")) return fail("unsupported", "Attribute value required");
    if (kind === "KV" && (!seen.has(1) || !seen.has(2))) return fail("unsupported", "Attribute key/value required");
    return key;
  }
  walk("Request", 0, bytes.length, 0, 0);
  return counts;
}
