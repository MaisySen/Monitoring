import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Per-organization ingestion quotas and usage metering. Limits live in org_quotas (NULL = unlimited).
 *
 * Enforcement is safe with multiple server processes sharing one PostgreSQL: every reservation is a
 * single atomic statement holding a row lock, so concurrent batches across processes cannot combine
 * past a limit. Daily counters and the per-minute byte window live in PostgreSQL (org_usage_daily,
 * org_usage_minute); the in-memory cache of the *limits* refreshes within ~2 seconds per process, so a limit change reaches every process of a multi-process deployment within that bound.
 *
 * Crash/retry semantics: reservation happens before storage, so a crash between the two over-counts
 * usage (conservative; intake is refused earlier, never over-admitted). A client retry of an accepted
 * batch after an ambiguous failure counts usage again, same conservative direction. A refused batch is
 * all-or-nothing: it is rejected whole with 429 even when part of it would fit.
 *
 * Enforcement points: intake/routes.ts (per-minute request bytes, on the wire) and intake/store.ts
 * (daily points/logs/spans, metric series cap under a per-organization advisory lock). The series cap
 * is enforced for PostgreSQL storage; ClickHouse installs are for large volumes and the cap does not
 * apply there.
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

const CACHE_TTL = 2_000;
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

// ---- daily usage (PostgreSQL, atomic across processes) ----
const USAGE_COLS = { points: "points", logs: "logs", spans: "spans" } as const;
export type UsageKind = keyof typeof USAGE_COLS;

/**
 * Reserve n units of a daily quota in one atomic statement: concurrent batches in any process serialize
 * on the usage row, and the increment only lands when it fits the limit. Returns false when refused.
 */
export async function admitDaily(
  orgId: number,
  kind: UsageKind,
  n: number,
  limit: number | null,
  q: { query: (text: string, values?: unknown[]) => Promise<unknown> } = pool,
): Promise<boolean> {
  if (n <= 0) return true;
  const col = USAGE_COLS[kind];
  if (limit == null) {
    await q.query(
      `insert into org_usage_daily (org_id, day, ${col}) values ($1, current_date, $2)
       on conflict (org_id, day) do update set ${col} = org_usage_daily.${col} + $2`,
      [orgId, n],
    );
    return true;
  }
  const r = (await q.query(
    `insert into org_usage_daily (org_id, day, ${col}) values ($1, current_date, least($2::bigint, $3))
     on conflict (org_id, day) do update set ${col} = org_usage_daily.${col} + $2::bigint
     where org_usage_daily.${col} + $2::bigint <= $3
     returning ${col}`,
    [orgId, n, limit],
  )) as { rowCount: number | null };
  // The update path only lands when the batch fits whole. The insert path charges least(n, limit):
  // a batch bigger than the whole limit is refused (and consumes the window, so oversized batches
  // cannot be retried through within the same window); anything else that landed fit whole.
  if (r.rowCount === 0) return false;
  return n <= limit;
}

export async function usageToday(orgId: number): Promise<{ day: string; points: number; logs: number; spans: number }> {
  const r = await pool.query("select day::text, points, logs, spans from org_usage_daily where org_id=$1 and day=current_date", [orgId]);
  const row = r.rows[0];
  return {
    day: row ? String(row.day).slice(0, 10) : new Date().toISOString().slice(0, 10),
    points: Number(row?.points ?? 0),
    logs: Number(row?.logs ?? 0),
    spans: Number(row?.spans ?? 0),
  };
}

// ---- per-minute request byte window (PostgreSQL, atomic across processes) ----

const n_fits = (n: number, limit: number) => n <= limit;

export async function checkByteRate(orgId: number, bytes: number, limit: number | null): Promise<boolean> {
  if (limit == null || bytes <= 0) return true;
  const minute = Math.floor(Date.now() / 60_000);
  const r = await pool.query(
    `insert into org_usage_minute (org_id, minute, bytes) values ($1, $2, least($3::bigint, $4::bigint))
     on conflict (org_id, minute) do update set bytes = org_usage_minute.bytes + $3::bigint
     where org_usage_minute.bytes + $3::bigint <= $4
     returning bytes`,
    [orgId, minute, bytes, limit],
  );
  // Same contract as admitDaily: a batch bigger than the whole window is refused (and charged up to
  // the limit); the update path only lands when the batch fits whole.
  if (r.rowCount === 0) return false;
  return n_fits(bytes, limit);
}

export async function bytesThisMinute(orgId: number): Promise<number> {
  const r = await pool.query("select bytes from org_usage_minute where org_id=$1 and minute=$2", [orgId, Math.floor(Date.now() / 60_000)]);
  return Number(r.rows[0]?.bytes ?? 0);
}

/** A batch refused by a daily quota: the intake layer answers 429 with this reason and records the drop. */
export class QuotaExceeded extends Error {
  readonly status = 429;
  constructor(
    public readonly path: string,
    public readonly count: number,
    public readonly quotaReason: string,
  ) {
    super(`Organization ${quotaReason.replace("quota:", "").replaceAll("_", " ")} limit reached; data was not stored. Raise the limit in Organization Settings or reduce volume.`);
    this.name = "QuotaExceeded";
  }
}

/** Current metric series count (PostgreSQL storage), for the series cap and the usage display. */
export async function seriesCount(orgId: number): Promise<number> {
  const r = await pool.query("select count(*)::int as n from metric_series where org_id=$1", [orgId]);
  return r.rows[0]?.n ?? 0;
}
