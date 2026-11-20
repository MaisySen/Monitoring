import { fingerprintFor, normalizeMessage } from "./errorGroups";

// Exception incidents for the Now page: active error groups plus where their occurrences
// landed (endpoints, versions), computed from a bounded scan of recent error spans.
//
// Wording contract (do not weaken): first_seen is an observation fact ("first seen <time>");
// versions are listed as observed versions. Never state or imply that an exception "started
// after a deploy" - that requires deployment-time evidence, which the product does not have
// unless a deploy marker feature lands. Version concentration is a lead, not a cause.

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
    for (const s of spans) {
      const meta = s.meta ?? {};
      const fp = fingerprintFor(g.service, (meta["error.type"] ?? "").slice(0, 200), normalizeMessage(meta["error.message"] ?? ""));
      if (fp !== g.fingerprint) continue;
      matchedTotal += 1;
      const ep = (s.resource ?? "").trim() || (s.name ?? "").trim();
      if (ep) endpoints.set(ep, (endpoints.get(ep) ?? 0) + 1);
      const v = (meta["version"] ?? "").trim();
      if (v) versions.set(v, (versions.get(v) ?? 0) + 1);
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
  return buildIncidents(groups, cand, nowMs, { scanTruncated: cand.length >= INCIDENT_SCAN_LIMIT });
}
