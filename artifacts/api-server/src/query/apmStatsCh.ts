/** APM rollup reads for ClickHouse storage; the Postgres version and the rollup design are described in apmStats.ts. */
import { chQuery, ensureChSchema, ChParams } from "../lib/ch";

const GAMMA = 1.04; // bucket i covers (1µs·γ^(i-1), 1µs·γ^i]; value error ≤ (γ-1)/(γ+1) ≈ 2%
const LOG_GAMMA = Math.log(GAMMA);
const MIN_NS = 1000;

export function bucketOf(durationNs: number): number {
  if (!(durationNs > MIN_NS)) return 0;
  return Math.ceil(Math.log(durationNs / MIN_NS) / LOG_GAMMA);
}
function valueOf(idx: number): number {
  if (idx <= 0) return MIN_NS;
  // geometric midpoint of the bucket, in ns
  return MIN_NS * Math.pow(GAMMA, idx) * (2 / (1 + GAMMA));
}

// ClickHouse storage (MONITORING_STORAGE=clickhouse): span_stats is filled by a materialized view on spans (lib/ch.ts),
// so there is nothing to record or flush at intake; these read it, merging the histograms with sumMap.
export async function ensureSpanStats() {
  await ensureChSchema();
}

class Hist {
  m = new Map<number, number>();
  n = 0;
  add(idx: number[], cnt: number[]) {
    for (let i = 0; i < idx.length; i++) {
      this.m.set(idx[i], (this.m.get(idx[i]) ?? 0) + cnt[i]);
      this.n += cnt[i];
    }
  }
  q(p: number): number {
    if (!this.n) return 0;
    const rank = p * (this.n - 1);
    let seen = 0;
    for (const k of [...this.m.keys()].sort((a, b) => a - b)) {
      seen += this.m.get(k)!;
      if (seen > rank) return valueOf(k);
    }
    return valueOf(Math.max(...this.m.keys()));
  }
}

// A minute bucket overlaps the range if any part of it is inside [from, to).
function rangeWhere(b: ChParams, orgId: number, from: number, to: number) {
  return `org_id = ${b.p(orgId, "UInt32")} AND bucket > ${b.p(from - 60, "Int64")} AND bucket < ${b.p(to, "Int64")}`;
}
const AGG = "sum(hits) AS hits, sum(errors) AS errors, sum(dur_sum) AS dur_sum, max(dur_max) AS dur_max, sumMap(hist) AS h";

type G = { first: any; hits: number; errors: number; total: number; max: number; h: Hist; types: Set<string>; envs: Set<string>; langs: Set<string> };
function toGroup(r: any): G {
  const h = new Hist();
  const [idx, cnt] = r.h ?? [[], []];
  h.add(idx.map(Number), cnt.map(Number));
  return {
    first: r,
    hits: Number(r.hits),
    errors: Number(r.errors),
    total: Number(r.dur_sum),
    max: Number(r.dur_max),
    h,
    types: new Set(r.types ?? []),
    envs: new Set(r.envs ?? []),
    langs: new Set(r.langs ?? []),
  };
}

export async function serviceSummary(orgId: number, from: number, to: number, env: string | null) {
  await ensureSpanStats();
  const b = new ChParams();
  const rows = await chQuery(
    `SELECT service, groupUniqArray(type) AS types, groupUniqArray(env) AS envs, groupUniqArray(lang) AS langs, ${AGG}
    FROM span_stats WHERE ${rangeWhere(b, orgId, from, to)} ${env ? `AND env = ${b.p(env)}` : ""} GROUP BY service ORDER BY service`,
    b.params,
  );
  return rows.map((r) => {
    const x = toGroup(r);
    return {
      service: r.service,
      type: [...x.types].filter(Boolean).sort().at(-1) ?? "",
      envs: [...x.envs],
      language: [...x.langs].filter(Boolean).sort().at(-1) || null,
      hits: x.hits,
      errors: x.errors,
      p50: x.h.q(0.5),
      p95: x.h.q(0.95),
      p99: x.h.q(0.99),
      avg: x.hits ? x.total / x.hits : 0,
      total: x.total,
    };
  });
}

export async function serviceTimeseries(orgId: number, service: string, from: number, to: number, interval: number) {
  await ensureSpanStats();
  const step = Math.max(60, interval);
  const b = new ChParams();
  const rows = await chQuery(
    `SELECT intDiv(bucket, ${step}) * ${step} AS b, ${AGG} FROM span_stats
    WHERE ${rangeWhere(b, orgId, from, to)} AND service = ${b.p(service)} GROUP BY b ORDER BY b`,
    b.params,
  );
  return rows.map((r) => {
    const x = toGroup(r);
    return { t: Number(r.b) * 1000, hits: x.hits, errors: x.errors, p50: x.h.q(0.5), p95: x.h.q(0.95), p99: x.h.q(0.99), max: x.max };
  });
}

export async function serviceResources(orgId: number, service: string, from: number, to: number) {
  await ensureSpanStats();
  const b = new ChParams();
  const rows = await chQuery(
    `SELECT resource, name, ${AGG} FROM span_stats
    WHERE ${rangeWhere(b, orgId, from, to)} AND service = ${b.p(service)} GROUP BY resource, name ORDER BY hits DESC LIMIT 200`,
    b.params,
  );
  const span = Math.max(1, to - from);
  return rows.map((r) => {
    const x = toGroup(r);
    return {
      resource: r.resource,
      name: r.name,
      hits: x.hits,
      errors: x.errors,
      p50: x.h.q(0.5),
      p95: x.h.q(0.95),
      p99: x.h.q(0.99),
      total: x.total,
      rps: x.hits / span,
    };
  });
}

export async function serviceOperations(orgId: number, service: string, from: number, to: number) {
  await ensureSpanStats();
  const b = new ChParams();
  return (await chQuery(`SELECT DISTINCT name FROM span_stats WHERE ${rangeWhere(b, orgId, from, to)} AND service = ${b.p(service)}`, b.params)).map(
    (r) => r.name as string,
  );
}

export async function apmEnvs(orgId: number, since: number) {
  const b = new ChParams();
  return (await chQuery(`SELECT DISTINCT env FROM span_stats WHERE org_id = ${b.p(orgId, "UInt32")} AND bucket > ${b.p(since, "Int64")}`, b.params))
    .map((r) => r.env as string)
    .filter(Boolean);
}
