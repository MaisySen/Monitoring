import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Per-organization ingestion quotas and usage metering. Limits live in org_quotas (NULL = unlimited);
 * daily usage is counted in memory and persisted to org_usage_daily for display and restart recovery.
 * The server is a single process (see SELF_HOSTING), so in-memory counters are authoritative;
 * the database copy can lag by the writes in flight at a crash.
 *
 * Enforcement points: intake/routes.ts (per-minute request bytes, on the wire) and intake/store.ts
 * (daily points/logs/spans, metric series cap). The series cap is enforced for PostgreSQL storage;
 * ClickHouse installs track high-cardinality volume differently and the cap does not apply there.
 */
export interface OrgQuotas {
  maxSeries: number | null;
  maxPointsPerDay: number | null;
  maxLogsPerDay: number | null;
  maxSpansPerDay: number | null;
  maxIngestBytesPerMinute: number | null;
}

export const QUOTA_FIELDS = ["maxSeries", "maxPointsPerDay", "maxLogsPerDay", "maxSpansPerDay", "maxIngestBytesPerMinute"] as const;

const COLS: Record<keyof OrgQuotas, string> = {
  maxSeries: "max_series",
  maxPointsPerDay: "max_points_per_day",
  maxLogsPerDay: "max_logs_per_day",
  maxSpansPerDay: "max_spans_per_day",
  maxIngestBytesPerMinute: "max_ingest_bytes_per_minute",
};

const CACHE_TTL = 10_000;
const quotaCache = new Map<number, { q: OrgQuotas; at: number }>();

function rowToQuotas(row: any): OrgQuotas {
  return {
    maxSeries: row?.max_series ?? null,
    maxPointsPerDay: row?.max_points_per_day ?? null,
    maxLogsPerDay: row?.max_logs_per_day ?? null,
    maxSpansPerDay: row?.max_spans_per_day ?? null,
    maxIngestBytesPerMinute: row?.max_ingest_bytes_per_minute ?? null,
  };
}

export async function getQuotas(orgId: number): Promise<OrgQuotas> {
  const c = quotaCache.get(orgId);
  if (c && Date.now() - c.at < CACHE_TTL) return c.q;
  const r = await pool.query("select * from org_quotas where org_id=$1", [orgId]);
  const q = rowToQuotas(r.rows[0]);
  quotaCache.set(orgId, { q, at: Date.now() });
  return q;
}

export function invalidateQuotas(orgId: number) {
  quotaCache.delete(orgId);
}

export async function setQuotas(orgId: number, q: OrgQuotas): Promise<void> {
  await pool.query(
    `insert into org_quotas (org_id, max_series, max_points_per_day, max_logs_per_day, max_spans_per_day, max_ingest_bytes_per_minute)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (org_id) do update set max_series=$2, max_points_per_day=$3, max_logs_per_day=$4,
       max_spans_per_day=$5, max_ingest_bytes_per_minute=$6, updated_at=now()`,
    [orgId, q.maxSeries, q.maxPointsPerDay, q.maxLogsPerDay, q.maxSpansPerDay, q.maxIngestBytesPerMinute],
  );
  invalidateQuotas(orgId);
}

/** Validate a PUT body: every known field must be null (unlimited) or a safe non-negative integer. */
export function parseQuotas(body: any): OrgQuotas | string {
  const out: OrgQuotas = { maxSeries: null, maxPointsPerDay: null, maxLogsPerDay: null, maxSpansPerDay: null, maxIngestBytesPerMinute: null };
  for (const f of QUOTA_FIELDS) {
    const v = body?.[f];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0 || n > 2_147_483_647) return `${f} must be a whole number between 0 and 2147483647, or empty for no limit`;
    (out as any)[f] = n;
  }
  return out;
}

// ---- daily usage ----
type DayCounter = { day: string; points: number; logs: number; spans: number; loaded: boolean };
const dayCounters = new Map<number, DayCounter>();
const USAGE_COLS = { points: "points", logs: "logs", spans: "spans" } as const;
export type UsageKind = keyof typeof USAGE_COLS;

async function counter(orgId: number): Promise<DayCounter> {
  const today = new Date().toISOString().slice(0, 10);
  let c = dayCounters.get(orgId);
  if (!c || c.day !== today) {
    c = { day: today, points: 0, logs: 0, spans: 0, loaded: false };
    dayCounters.set(orgId, c);
  }
  if (!c.loaded) {
    c.loaded = true;
    try {
      const r = await pool.query("select points, logs, spans from org_usage_daily where org_id=$1 and day=current_date", [orgId]);
      if (r.rows[0]) {
        c.points += Number(r.rows[0].points);
        c.logs += Number(r.rows[0].logs);
        c.spans += Number(r.rows[0].spans);
      }
    } catch (e) {
      // A missing usage table (schema mid-upgrade) must never block ingestion.
      c.loaded = false;
      logger.warn({ err: String(e) }, "usage counter load failed");
    }
  }
  return c;
}

/**
 * Reserve n units of a daily quota. Returns true and counts the batch when the org is under its limit;
 * returns false (and counts nothing) once the limit is reached. A batch may carry usage slightly past
 * the limit; the next batch is refused.
 */
export async function admitDaily(orgId: number, kind: UsageKind, n: number, limit: number | null): Promise<boolean> {
  if (n <= 0) return true;
  const c = await counter(orgId);
  if (limit != null && c[kind] >= limit) return false;
  c[kind] += n;
  const col = USAGE_COLS[kind];
  pool
    .query(
      `insert into org_usage_daily (org_id, day, ${col}) values ($1, current_date, $2)
       on conflict (org_id, day) do update set ${col} = org_usage_daily.${col} + $2`,
      [orgId, n],
    )
    .catch((e) => logger.debug({ err: String(e) }, "usage persist failed"));
  return true;
}

export async function usageToday(orgId: number): Promise<{ day: string; points: number; logs: number; spans: number }> {
  const c = await counter(orgId);
  return { day: c.day, points: c.points, logs: c.logs, spans: c.spans };
}

// ---- per-minute request byte window (in-memory, single-process) ----
const minuteWindow = new Map<number, { minute: number; bytes: number }>();

export function checkByteRate(orgId: number, bytes: number, limit: number | null): boolean {
  if (limit == null || bytes <= 0) return true;
  const minute = Math.floor(Date.now() / 60_000);
  const w = minuteWindow.get(orgId);
  const cur = w && w.minute === minute ? w.bytes : 0;
  if (cur + bytes > limit) return false;
  minuteWindow.set(orgId, { minute, bytes: cur + bytes });
  return true;
}

export function bytesThisMinute(orgId: number): number {
  const w = minuteWindow.get(orgId);
  return w && w.minute === Math.floor(Date.now() / 60_000) ? w.bytes : 0;
}

/** Current metric series count (PostgreSQL storage), for the series cap and the usage display. */
export async function seriesCount(orgId: number): Promise<number> {
  const r = await pool.query("select count(*)::int as n from metric_series where org_id=$1", [orgId]);
  return r.rows[0]?.n ?? 0;
}
