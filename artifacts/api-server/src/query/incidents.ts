import { fingerprintFor, normalizeMessage } from "./errorGroups";

// Exception incidents for the Now page: active error groups plus where their occurrences
// landed (endpoints, versions), computed from a bounded scan of recent error spans.
//
// Wording contract (do not weaken): first_seen is an observation fact ("first seen <time>");
// versions are listed as observed versions. Monitoring has NO deployment records: the
// service_versions table records when a version was first OBSERVED sending spans in an
// environment, not when anything was deployed. Never call a version observation a deploy
// or deploy time anywhere. The versionTimingFor rule below may surface version-first-
// observed timing only with COMPLETE observation coverage in a single environment -
// untruncated scan, zero untagged matched spans, exactly one version and one env among
// matched spans, and the version's env-scoped first observation strictly before the
// group's first sighting. The wording is "version first observed before this exception",
// an observation-timing fact, never "started after a deploy" and never cause.

export interface IncidentGroupRow {
  fingerprint: string;
  service: string;
  envs: string[];
  error_type: string;
  message_example: string;
  first_seen: number | string;
  last_seen: number | string;
  count: number | string;
}

export interface ErrorSpanRow {
  service: string;
  name: string;
  // Ingest normalizes the span op into `name` ("http.server.request"); the route/method
  // ("GET /fail") lives in `resource`. Endpoint ranking uses resource, falling back to name.
  resource: string | null;
  env: string | null;
  meta: Record<string, string> | null;
}

export interface ExceptionIncident {
  fingerprint: string;
  service: string;
  envs: string[];
  errorType: string;
  messageExample: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  // First observed within the last hour: an observation-time fact, not a deploy claim.
  isNew: boolean;
  topEndpoints: { name: string; count: number }[];
  versionsObserved: string[];
  // Uncapped observation state for the version-timing rule (display stays capped):
  matchedVersionsDistinct: number;
  matchedSingleVersion: string | null;
  matchedEnvsDistinct: number;
  matchedSingleEnv: string | null;
  matchedUntagged: number;
  // Set only by versionTimingFor when its full rule passes; null otherwise. Observation
  // timing only - NOT a deploy marker (Monitoring has no deployment records).
  versionTiming: { version: string; env: string; versionFirstSeen: number } | null;
  coverage: { matchedTotal: number; groupCount: number; scanned: number; scanTruncated: boolean; windowDays: number };
}

export const INCIDENT_WINDOW_DAYS = 1;
export const INCIDENT_SCAN_LIMIT = 2000;
const MAX_ENDPOINTS = 3;
const MAX_VERSIONS = 3;

export function buildIncidents(
  groups: IncidentGroupRow[],
  scannedSpans: ErrorSpanRow[],
  nowMs: number,
  opts: { scanTruncated: boolean },
): ExceptionIncident[] {
  const byService = new Map<string, ErrorSpanRow[]>();
  for (const s of scannedSpans) {
    const list = byService.get(s.service) ?? [];
    list.push(s);
    byService.set(s.service, list);
  }
  const out: ExceptionIncident[] = [];
  for (const g of groups) {
    const spans = byService.get(g.service) ?? [];
    const endpoints = new Map<string, number>();
    const versions = new Map<string, number>();
    const envsMatched = new Map<string, number>();
    let matchedTotal = 0;
    let matchedUntagged = 0;
    for (const s of spans) {
      const meta = s.meta ?? {};
      const fp = fingerprintFor(g.service, (meta["error.type"] ?? "").slice(0, 200), normalizeMessage(meta["error.message"] ?? ""));
      if (fp !== g.fingerprint) continue;
      matchedTotal += 1;
      const ep = (s.resource ?? "").trim() || (s.name ?? "").trim();
      if (ep) endpoints.set(ep, (endpoints.get(ep) ?? 0) + 1);
      const env = (s.env ?? "").trim() || "unknown";
      envsMatched.set(env, (envsMatched.get(env) ?? 0) + 1);
      const v = (meta["version"] ?? "").trim();
      if (v) versions.set(v, (versions.get(v) ?? 0) + 1);
      else matchedUntagged += 1;
    }
    const topEndpoints = [...endpoints.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENDPOINTS)
      .map(([name, count]) => ({ name, count }));
    const versionOverflow = [...versions.entries()].sort((a, b) => b[1] - a[1]).slice(MAX_VERSIONS).reduce((n, [, c]) => n + c, 0);
    const versionsObserved = [...versions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VERSIONS)
      .map(([v, c]) => v)
      .concat(versionOverflow > 0 ? [`(+${versions.size - MAX_VERSIONS} more)`] : []);
    out.push({
      fingerprint: g.fingerprint,
      service: g.service,
      envs: g.envs ?? [],
      errorType: g.error_type,
      messageExample: g.message_example,
      count: Number(g.count),
      firstSeen: Number(g.first_seen),
      lastSeen: Number(g.last_seen),
      isNew: Number(g.first_seen) >= nowMs - 60 * 60_000,
      topEndpoints,
      versionsObserved,
      matchedVersionsDistinct: versions.size,
      matchedSingleVersion: versions.size === 1 ? [...versions.keys()][0] : null,
      matchedEnvsDistinct: envsMatched.size,
      matchedSingleEnv: envsMatched.size === 1 ? [...envsMatched.keys()][0] : null,
      matchedUntagged,
      versionTiming: null,
      coverage: {
        matchedTotal,
        groupCount: Number(g.count),
        scanned: scannedSpans.length,
        scanTruncated: opts.scanTruncated,
        windowDays: INCIDENT_WINDOW_DAYS,
      },
    });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}

// The version-first-observed timing rule. This is NOT deploy evidence: Monitoring records
// when a version was first observed sending spans in an environment, never deployment
// events. Every gate must pass before ANY version-timing line is shown:
//   1. the error-span scan was not truncated (coverage is complete);
//   2. at least one matched span was observed;
//   3. every matched span carries a version tag (a single untagged span could be an older
//      version, so coverage with gaps forbids the claim);
//   4. all matched spans carry exactly one distinct version V;
//   5. all matched spans are in exactly one environment E - a version observed first in
//      staging says nothing about prod, so mixed-env matches forbid the claim;
//   6. service_versions holds an (service, E, V) row - the observation record, written in
//      the same intake transaction as the spans themselves;
//   7. the version's env-scoped first_seen is STRICTLY before the group's first_seen.
//      Equal timestamps cannot be ordered (same batch), so they make no claim.
// The licensed wording is observational: "version V first observed in E before this
// exception's first sighting" - never a deploy claim, never cause.
export function versionTimingFor(
  inc: Pick<ExceptionIncident, "service" | "firstSeen" | "matchedVersionsDistinct" | "matchedSingleVersion" | "matchedEnvsDistinct" | "matchedSingleEnv" | "matchedUntagged" | "coverage">,
  versionsByService: Map<string, Map<string, Map<string, number>>>,
): { version: string; env: string; versionFirstSeen: number } | null {
  if (inc.coverage.scanTruncated) return null;
  if (inc.coverage.matchedTotal === 0) return null;
  if (inc.matchedUntagged > 0) return null;
  if (inc.matchedVersionsDistinct !== 1 || !inc.matchedSingleVersion) return null;
  if (inc.matchedEnvsDistinct !== 1 || !inc.matchedSingleEnv) return null;
  const firstSeen = versionsByService.get(inc.service)?.get(inc.matchedSingleEnv)?.get(inc.matchedSingleVersion);
  if (firstSeen == null) return null;
  if (firstSeen >= inc.firstSeen) return null;
  return { version: inc.matchedSingleVersion, env: inc.matchedSingleEnv, versionFirstSeen: firstSeen };
}

export async function computeExceptionIncidents(
  pool: { query: (q: string, v?: any[]) => Promise<{ rows: any[] }> },
  orgId: number,
  nowMs: number,
): Promise<ExceptionIncident[]> {
  const sinceMs = nowMs - INCIDENT_WINDOW_DAYS * 24 * 3600_000;
  const groups = (
    await pool.query(
      `select fingerprint, service, envs, error_type, message_example, first_seen, last_seen, count
       from error_groups where org_id=$1 and last_seen >= $2 order by last_seen desc limit 10`,
      [orgId, sinceMs],
    )
  ).rows as IncidentGroupRow[];
  if (groups.length === 0) return [];
  const services = [...new Set(groups.map((g) => g.service))];
  const cand = (
    await pool.query(
      `select service, name, resource, env, meta from spans
       where org_id=$1 and service = any($2) and error=1 and start_ms >= $3
       order by start_ms desc limit ${INCIDENT_SCAN_LIMIT}`,
      [orgId, services, sinceMs],
    )
  ).rows as ErrorSpanRow[];
  const out = buildIncidents(groups, cand, nowMs, { scanTruncated: cand.length >= INCIDENT_SCAN_LIMIT });
  // Version observation records: first sighting per (service, env, version) from intake.
  // Guarded like error_groups: on a backend without the table, no timing lines - never a crash.
  const hasSv = (await pool.query("select to_regclass('service_versions') is not null as e")).rows[0].e;
  if (hasSv) {
    const sv = (
      await pool.query(`select service, env, version, first_seen from service_versions where org_id=$1 and service = any($2)`, [orgId, services])
    ).rows as { service: string; env: string; version: string; first_seen: number | string }[];
    const byService = new Map<string, Map<string, Map<string, number>>>();
    for (const r of sv) {
      let byEnv = byService.get(r.service);
      if (!byEnv) byService.set(r.service, (byEnv = new Map()));
      let byVersion = byEnv.get(r.env);
      if (!byVersion) byEnv.set(r.env, (byVersion = new Map()));
      byVersion.set(r.version, Number(r.first_seen));
    }
    for (const inc of out) inc.versionTiming = versionTimingFor(inc, byService);
  }
  return out;
}
