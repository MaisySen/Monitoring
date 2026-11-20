import { createHash } from "node:crypto";

// Error fingerprint grouping (PG backend only; the ClickHouse intake path does not maintain
// error_groups yet). Groups error spans at intake by (service, error.type, normalized
// error.message) so the same recurring exception collapses into one group with a count,
// instead of one row per occurrence. Normalization strips the parts of a message that vary
// per occurrence (numbers, ids, quoted values) so "user 42 not found" and "user 43 not
// found" share a group; the first raw message is kept as the example.
//
// Deliberately not part of the fingerprint: stack frames (language-specific, brittle across
// agent versions) and env (an env tag change starting a new group is more honest than
// merging staging and prod errors silently). Because env is excluded, one group can span
// environments: the row tracks every env seen (envs array), never a single implied env.

export interface ErrorSpanLike {
  service: string;
  env: string;
  error: number;
  start: number; // ns
  meta: Record<string, string>;
}

export interface ErrorGroupAgg {
  fingerprint: string;
  service: string;
  envs: string[];
  errorType: string;
  messageExample: string;
  firstSeenMs: number;
  lastSeenMs: number;
  count: number;
}

const MAX_EXAMPLE = 500;

// Replace occurrence-varying fragments with placeholders, in a fixed order so the result
// is stable for a given message shape.
export function normalizeMessage(msg: string): string {
  return msg
    .slice(0, 2000)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][^\s"']*/g, "<ts>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintFor(service: string, errorType: string, normalizedMessage: string): string {
  return createHash("sha1").update(`${service}${errorType}${normalizedMessage}`).digest("hex").slice(0, 16);
}

// Aggregate fresh error spans into per-group deltas. Spans with error=1 but no error.type /
// error.message in meta still group, under a generic fingerprint per service, so unexplained
// errors are visible rather than dropped.
export function aggregateErrorGroups(spans: ErrorSpanLike[]): ErrorGroupAgg[] {
  const groups = new Map<string, ErrorGroupAgg>();
  for (const s of spans) {
    if (!s.error) continue;
    const type = (s.meta?.["error.type"] ?? "").slice(0, 200);
    const rawMsg = s.meta?.["error.message"] ?? "";
    const fp = fingerprintFor(s.service || "unnamed-service", type, normalizeMessage(rawMsg));
    const ms = Math.floor(s.start / 1e6);
    const g = groups.get(fp);
    if (g) {
      g.count += 1;
      if (ms < g.firstSeenMs) g.firstSeenMs = ms;
      if (ms > g.lastSeenMs) g.lastSeenMs = ms;
      if (s.env && !g.envs.includes(s.env)) g.envs.push(s.env);
    } else {
      groups.set(fp, {
        fingerprint: fp,
        service: s.service || "unnamed-service",
        envs: s.env ? [s.env] : [],
        errorType: type,
        messageExample: (rawMsg || "(no error.message)").slice(0, MAX_EXAMPLE),
        firstSeenMs: ms,
        lastSeenMs: ms,
        count: 1,
      });
    }
  }
  return [...groups.values()];
}

// Upsert batch deltas inside the caller's transaction (same atomicity story as span_stats:
// a crash cannot split committed spans from their error-group contribution, and a lost-
// response retry re-delivers nothing because callers pass only fresh spans).
export async function upsertErrorGroupsTx(c: { query: (q: string, v?: any[]) => Promise<any> }, orgId: number, groups: ErrorGroupAgg[]) {
  if (!groups.length) return;
  const vals: any[] = [];
  const rows: string[] = [];
  for (const g of groups) {
    const b = vals.length;
    vals.push(orgId, g.fingerprint, g.service, g.envs, g.errorType, g.messageExample, g.firstSeenMs, g.lastSeenMs, g.count);
    rows.push(`(${Array.from({ length: 9 }, (_, j) => `$${b + j + 1}`).join(",")})`);
  }
  await c.query(
    `insert into error_groups (org_id, fingerprint, service, envs, error_type, message_example, first_seen, last_seen, count)
     values ${rows.join(",")}
     on conflict (org_id, fingerprint) do update set
       last_seen = greatest(error_groups.last_seen, excluded.last_seen),
       first_seen = least(error_groups.first_seen, excluded.first_seen),
       count = error_groups.count + excluded.count,
       envs = (select array(select distinct e from unnest(error_groups.envs || excluded.envs) as e order by e limit 10))`,
    vals,
  );
}

// ---------- Version/environment correlation assembly (hypothesis aid only) ----------
// Comparability rules baked in here (product direction):
// - The error numerator comes from a BOUNDED scan and can be truncated; coverage is carried
//   explicitly (matchedTotal vs groupCount, scanned, scanTruncated) and must be shown wherever
//   the table is read.
// - The traffic denominator is ENTRY SPANS ONLY (operations), because raw span counts are
//   instrumentation volume: a version with deeper nested instrumentation would inflate its
//   denominator and fake a lower error concentration.
// - Both sides are grouped by (env, version) so a version deployed only in staging cannot
//   quietly read as a production regression.

export interface CorrelationMatch {
  env: string;
  version: string; // "" when untagged
}

export interface CorrelationTrafficRow {
  env: string;
  version: string;
  operations: number;
}

export interface VersionCorrelation {
  rows: { env: string; version: string; errors: number; operations: number }[];
  coverage: {
    matchedTotal: number;
    groupCount: number;
    scanned: number;
    scanTruncated: boolean;
    windowDays: number;
    denominator: "entry_spans";
  };
}

export const UNTAGGED = "(no version tag)";
export const NO_ENV = "(no env tag)";

export function buildVersionCorrelation(
  matches: CorrelationMatch[],
  traffic: CorrelationTrafficRow[],
  coverage: { groupCount: number; scanned: number; scanTruncated: boolean; windowDays: number },
): VersionCorrelation {
  const rows = new Map<string, { env: string; version: string; errors: number; operations: number }>();
  const key = (env: string, version: string) => `${env}${version}`;
  for (const m of matches) {
    const env = m.env || NO_ENV;
    const version = m.version || UNTAGGED;
    const k = key(env, version);
    const r = rows.get(k) ?? { env, version, errors: 0, operations: 0 };
    r.errors += 1;
    rows.set(k, r);
  }
  for (const t of traffic) {
    const env = t.env || NO_ENV;
    const version = t.version || UNTAGGED;
    const k = key(env, version);
    const r = rows.get(k) ?? { env, version, errors: 0, operations: 0 };
    r.operations += t.operations;
    rows.set(k, r);
  }
  return {
    rows: [...rows.values()].sort((a, b) => b.errors - a.errors || b.operations - a.operations),
    coverage: {
      matchedTotal: matches.length,
      groupCount: coverage.groupCount,
      scanned: coverage.scanned,
      scanTruncated: coverage.scanTruncated,
      windowDays: coverage.windowDays,
      denominator: "entry_spans",
    },
  };
}
