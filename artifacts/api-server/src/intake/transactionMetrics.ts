// Internal PG-only candidate seam, NOT an intake route. Caller owns one already-
// BEGIN'd dedicated client, exact-key/lease locks and COMMIT/ROLLBACK/release.
// NO connection/transaction/cache/telemetry ownership here. Ordinary writeMetrics
// is untouched. SQL intentionally mirrors reviewed PG writeMetrics/quotas paths;
// differential scratch-DB tests must accompany any change to either copy.
import type { PointIn } from "./store";
export interface MetricWriteTransaction {
  query(sql: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export class TransactionMetricRefusal extends Error {
  constructor(readonly reason: "shape" | "series" | "points" | "bytes") { super("Atomic metric batch refused: " + reason); }
}
export type TransactionMetricPolicy = {
  originalBytes: number;
  nowSeconds: number;
  maxDerivedRows: number;
  hostInfo?: Map<string, { os?: string; agentVersion?: string; tags: string[] }>;
};
const ignored = new Set(["system", "trace", "service_check", "datadog", "monitoring", "runtime", "otelcol"]);
const tagsOf = (tags: string[]) => [...new Set((tags ?? []).filter(Boolean).map((t) => String(t).trim()).filter((t) => t && !t.startsWith("host:")))].sort();
/** Writes only on supplied transaction. Result is PRE-COMMIT, never a receipt.
 * All refusal/error paths require caller ROLLBACK. Zero derived rows still charge
 * original bytes once. Daily point quota charges derived rows, not source count.
 */
export async function writeMetricPointsOnTransaction(c: MetricWriteTransaction, org: number, input: PointIn[], policy: TransactionMetricPolicy) {
  if (!Number.isSafeInteger(org) || org < 1 || !Number.isSafeInteger(policy.originalBytes) || policy.originalBytes < 0 ||
      !Number.isSafeInteger(policy.nowSeconds) || policy.nowSeconds < 0 || !Number.isSafeInteger(policy.maxDerivedRows) || policy.maxDerivedRows < 0)
    throw new TransactionMetricRefusal("shape");
  let pointCount = 0;
  const series = input.map((p) => {
    if (typeof p.metric !== "string" || !p.metric || typeof p.host !== "string" || typeof p.type !== "string" || !Array.isArray(p.tags) || !p.tags.every((t) => typeof t === "string") || !Array.isArray(p.points)) throw new TransactionMetricRefusal("shape");
    for (const point of p.points) if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || (point[2] !== undefined && !Number.isFinite(point[2]))) throw new TransactionMetricRefusal("shape");
    pointCount += p.points.length;
    if (pointCount > policy.maxDerivedRows) throw new TransactionMetricRefusal("shape");
    const tags = tagsOf(p.tags);
    return { ...p, tags, tagsKey: tags.join(",") };
  }).filter((p) => p.points.length);
  // SAME advisory class/key as ordinary seriesIds. Ordinary never takes candidate
  // key/lease locks. Candidate order is key -> lease -> this series-admission lock.
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [`series-cap:${org}`]);
  const q = (await c.query("select max_series,max_points_per_day,max_ingest_bytes_per_minute from org_quotas where org_id=$1", [org])).rows[0] ?? {};
  const maxSeries = q.max_series ?? null, maxPoints = q.max_points_per_day ?? null, maxBytes = q.max_ingest_bytes_per_minute ?? null;
  // Byte window uses supplied observed server second, not process Date.now. SQL
  // same fit-whole reservation contract; caller rollback erases refused charges.
  if (policy.originalBytes > 0 && maxBytes !== null) {
    const r = await c.query(`insert into org_usage_minute (org_id,minute,bytes) values($1,$2,least($3::bigint,$4::bigint))
      on conflict(org_id,minute) do update set bytes=org_usage_minute.bytes+$3::bigint
      where org_usage_minute.bytes+$3::bigint<=$4 returning bytes`, [org, Math.floor(policy.nowSeconds / 60), policy.originalBytes, maxBytes]);
    if (!r.rowCount || policy.originalBytes > maxBytes) throw new TransactionMetricRefusal("bytes");
  }
  if (pointCount > 0) {
    const r = maxPoints === null
      ? await c.query(`insert into org_usage_daily(org_id,day,points) values($1,current_date,$2)
          on conflict(org_id,day) do update set points=org_usage_daily.points+$2 returning points`, [org, pointCount])
      : await c.query(`insert into org_usage_daily(org_id,day,points) values($1,current_date,least($2::bigint,$3::bigint))
          on conflict(org_id,day) do update set points=org_usage_daily.points+$2::bigint
          where org_usage_daily.points+$2::bigint<=$3 returning points`, [org, pointCount, maxPoints]);
    if (!r.rowCount || (maxPoints !== null && pointCount > maxPoints)) throw new TransactionMetricRefusal("points");
  }
  const keyOf = (p: { metric: string; host: string; tagsKey: string }) => JSON.stringify([p.metric, p.host, p.tagsKey]);
  const distinct = new Map<string, typeof series[number]>(); for (const p of series) distinct.set(keyOf(p), p);
  const sorted = [...distinct.entries()].sort(([a], [b]) => a.localeCompare(b));
  const resolved = new Map<string, number>();
  if (maxSeries !== null) {
    const count = Number((await c.query("select count(*)::int n from metric_series where org_id=$1", [org])).rows[0].n);
    let missing = 0;
    for (const [, p] of sorted) {
      const row = (await c.query("select id from metric_series where org_id=$1 and metric=$2 and host=$3 and tags_key=$4", [org, p.metric, p.host, p.tagsKey])).rows[0];
      if (!row) missing++;
    }
    if (count + missing > maxSeries) throw new TransactionMetricRefusal("series");
  }
  for (const [key, p] of sorted) {
    const row = (await c.query(`insert into metric_series(org_id,metric,host,tags,tags_key,type,unit,last_seen) values($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict(org_id,metric,host,tags_key) do update set last_seen=excluded.last_seen,type=excluded.type returning id`,
      [org, p.metric, p.host, p.tags, p.tagsKey, p.type, p.unit ?? null, policy.nowSeconds])).rows[0];
    resolved.set(key, row.id);
  }
  const hosts = new Map<string, Set<string>>();
  for (const p of series) {
    const id = resolved.get(keyOf(p))!;
    for (const [ts, value, weight] of p.points) await c.query("insert into metric_points(series_id,ts,value,weight) values($1,$2,$3,$4)", [id, Math.floor(ts), value, weight !== undefined && weight !== 1 ? weight : null]);
    if (p.host) {
      if (!hosts.has(p.host)) hosts.set(p.host, new Set());
      const app = p.metric.split(".")[0]; if (app && !ignored.has(app)) hosts.get(p.host)!.add(app);
    }
  }
  for (const [host, apps] of [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const info = policy.hostInfo?.get(host); if (info) apps.add("system");
    await c.query(`insert into hosts(org_id,name,apps,first_seen,last_seen,os,platform,agent_version,tags) values($1,$2,$3,$4,$4,$5,$5,$6,$7)
      on conflict(org_id,name) do update set last_seen=greatest(hosts.last_seen,excluded.last_seen),
      os=coalesce(excluded.os,hosts.os),platform=coalesce(excluded.platform,hosts.platform),agent_version=coalesce(excluded.agent_version,hosts.agent_version),
      tags=case when cardinality(excluded.tags)>0 then excluded.tags else hosts.tags end,
      apps=array(select distinct app from unnest(hosts.apps||excluded.apps) app order by app)`,
      [org, host, [...apps].sort(), policy.nowSeconds, info?.os ?? null, info?.agentVersion ?? null, info?.tags ?? []]);
  }
  return { derivedRows: pointCount, resolvedSeries: resolved.size, touchedHosts: hosts.size, originalBytes: policy.originalBytes };
}
