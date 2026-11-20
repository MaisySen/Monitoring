import { fingerprintFor, normalizeMessage } from "./errorGroups";

// Exception incidents for the Now page: active error groups plus where their occurrences
// landed (endpoints, versions), computed from a bounded scan of recent error spans.
//
// Wording contract (do not weaken): first_seen is an observation fact ("first seen <time>");
// versions are listed as observed versions. Never state or imply that an exception "started
// after a deploy" from version concentration alone. A deploy claim is allowed ONLY through
// deployEvidenceFor below: a service_versions row (the deploy evidence base, populated from
// the same transaction as intake) plus COMPLETE observation coverage - an untruncated scan
// in which every matched span carries exactly one version. Even then the wording is "first
// observed after deploy", a timing observation, never "caused by".

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
  // Uncapped observation state for the deploy-evidence rule (display stays capped):
  matchedVersionsDistinct: number;
  matchedSingleVersion: string | null;
  matchedUntagged: number;
  // Set only by deployEvidenceFor when its full rule passes; null otherwise.
  deployEvidence: { version: string; deployFirstSeen: number } | null;
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
    let matchedTotal = 0;
    let matchedUntagged = 0;
    for (const s of spans) {
      const meta = s.meta ?? {};
      const fp = fingerprintFor(g.service, (meta["error.type"] ?? "").slice(0, 200), normalizeMessage(meta["error.message"] ?? ""));
      if (fp !== g.fingerprint) continue;
      matchedTotal += 1;
      const ep = (s.resource ?? "").trim() || (s.name ?? "").trim();
      if (ep) endpoints.set(ep, (endpoints.get(ep) ?? 0) + 1);
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
      matchedUntagged,
      deployEvidence: null,
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

// The deploy-evidence rule. Every gate must pass before ANY deploy timing claim is made:
//   1. the error-span scan was not truncated (coverage is complete);
//   2. at least one matched span was observed;
//   3. every matched span carries a version tag (none untagged - a single untagged span
//      could be an older deploy, so coverage with gaps forbids the claim);
//   4. all matched spans carry exactly one distinct version V;
//   5. service_versions holds a row for (service, V) - the deploy evidence base, written
//      in the same intake transaction as the spans themselves;
//   6. the deploy's first_seen is STRICTLY before the group's first_seen. Equal timestamps
//      cannot be ordered (same batch), so they make no claim.
// The claim this licenses is observational: "first observed after deploy V", never cause.
export function deployEvidenceFor(
  inc: Pick<ExceptionIncident, "service" | "firstSeen" | "matchedVersionsDistinct" | "matchedSingleVersion" | "matchedUntagged" | "coverage">,
  deploysByService: Map<string, Map<string, number>>,
): { version: string; deployFirstSeen: number } | null {
  if (inc.coverage.scanTruncated) return null;
  if (inc.coverage.matchedTotal === 0) return null;
  if (inc.matchedUntagged > 0) return null;
  if (inc.matchedVersionsDistinct !== 1 || !inc.matchedSingleVersion) return null;
  const v = inc.matchedSingleVersion;
  const firstSeen = deploysByService.get(inc.service)?.get(v);
  if (firstSeen == null) return null;
  if (firstSeen >= inc.firstSeen) return null;
  return { version: v, deployFirstSeen: firstSeen };
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
  // Deploy evidence base: first observation per (service, version) from intake. Guarded like
  // error_groups: on a backend without the table, no deploy claims - never a crash.
  const hasSv = (await pool.query("select to_regclass('service_versions') is not null as e")).rows[0].e;
  if (hasSv) {
    const sv = (
      await pool.query(`select service, version, first_seen from service_versions where org_id=$1 and service = any($2)`, [orgId, services])
    ).rows as { service: string; version: string; first_seen: number | string }[];
    const deploys = new Map<string, Map<string, number>>();
    for (const r of sv) {
      let m = deploys.get(r.service);
      if (!m) deploys.set(r.service, (m = new Map()));
      m.set(r.version, Number(r.first_seen));
    }
    for (const inc of out) inc.deployEvidence = deployEvidenceFor(inc, deploys);
  }
  return out;
}
