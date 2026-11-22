import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { preflightRawAppMetrics } from "../../src/lib/rawAppMetrics";
import { decodeOtlp } from "../../src/intake/otlp";
import { prepareNormalAppMetrics } from "../../src/lib/normalAppContract";

// PREPARED SOURCE ONLY. No pool, connection, listener, mutation or top-level run.
// Caller must prove ownership of a fresh isolated candidate_* scratch DB.
type Query = { query(sql: string, args?: unknown[]): Promise<{ rows: any[] }> };
export type CapturedBatch = { id: string; bytes: Buffer; receipt: any };
const canonical = (x: unknown) => JSON.stringify(x);
const sorted = (xs: unknown[]) => xs.map(canonical).sort();
const tags = (xs: string[]) => [...new Set(xs.filter(Boolean).map(String).map(x => x.trim()).filter(x => x && !x.startsWith("host:")))].sort();

export async function verifyNormalAgentRealC(q: Query, orgId: number, batches: CapturedBatch[]) {
  assert.equal(orgId, 1, "dedicated scratch fixture org only");
  assert.equal(batches.length, 2, "two original initial/final collections required");
  assert.equal(new Set(batches.map(x => x.id)).size, batches.length, "distinct original leases");
  const expectedPoints: unknown[] = [];
  let derived = 0, totalBytes = 0;
  for (const [index, b] of batches.entries()) {
    assert.match(b.id, /^[a-f0-9]{32}$/);
    preflightRawAppMetrics(b.bytes);
    const prepared = prepareNormalAppMetrics(orgId, decodeOtlp("metrics", b.bytes, "application/x-protobuf"));
    if(index === 0) {
      assert.deepEqual([prepared.accounting.sourcePoints,prepared.accounting.numberPoints,prepared.accounting.explicitHistogramPoints,prepared.accounting.exponentialHistogramPoints,prepared.accounting.cumulativeSnapshotPoints],[4,3,1,0,1]);
      // Independent named instrument invariants from the actual SDK driver.
      const values = (name: string) => prepared.conversion.points.filter(p=>p.metric===name).flatMap(p=>p.points.map(x=>x[1]));
      assert.deepEqual(values("init.count"),[7]);assert.deepEqual(values("init.gauge"),[0]);
      assert.deepEqual(values("init.snapshot"),[-2]);assert.deepEqual(values("init.histogram.count"),[3]);
      assert.deepEqual(values("init.histogram.sum"),[17]);
    }
    const l = (await q.query("select org_id,key_id,sha,bytes,contract from candidate_app_leases where id=$1", [b.id])).rows;
    assert.equal(l.length, 1);
    assert.equal(l[0].org_id, orgId);
    assert.equal(l[0].key_id, 1);
    assert.equal(l[0].sha, createHash("sha256").update(b.bytes).digest("hex"));
    assert.equal(l[0].bytes, b.bytes.length);
    assert.equal(l[0].contract, prepared.accounting.contract);
    const r = (await q.query("select accounting,durability from candidate_app_receipts where id=$1", [b.id])).rows;
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].accounting, prepared.accounting);
    assert.equal(r[0].durability, "same-tx-synchronous-commit");
    assert.deepEqual(b.receipt, { state: "stored", protocol: "monitoring-node-app-service-test-v1", id: b.id, sha: l[0].sha, bytes: l[0].bytes, accounting: r[0].accounting, durability: r[0].durability });
    for (const p of prepared.conversion.points) for (const [ts, value, weight] of p.points) {
      // Mirrors writer storage representation, preserves multiplicity at same ts.
      expectedPoints.push([p.metric, p.host, tags(p.tags), Math.floor(ts), value, weight !== undefined && weight !== 1 ? weight : null]);
    }
    derived += prepared.accounting.derivedRows;
    totalBytes += b.bytes.length;
  }
  const actual = (await q.query("select s.metric,s.host,s.tags,p.ts,p.value,p.weight from metric_points p join metric_series s on s.id=p.series_id where s.org_id=$1", [orgId])).rows;
  const observed = actual.map(p => [p.metric, p.host, p.tags, Number(p.ts), Number(p.value), p.weight === null ? null : Number(p.weight)]);
  assert.deepEqual(sorted(observed), sorted(expectedPoints), "exact derived row multiset, not sum-only or timestamp dedup");
  assert.equal(actual.length, derived);
  const usage = (await q.query("select (select coalesce(sum(points),0) from org_usage_daily where org_id=$1) daily,(select coalesce(sum(bytes),0) from org_usage_minute where org_id=$1) bytes", [orgId])).rows[0];
  assert.equal(Number(usage.daily), derived);
  assert.equal(Number(usage.bytes), totalBytes, "requires finite seeded byte quota to activate writer accounting");
  assert.equal(Number((await q.query("select count(*) n from candidate_app_receipts")).rows[0].n), batches.length);
  assert.equal(Number((await q.query("select count(*) n from candidate_app_leases")).rows[0].n), batches.length);
  assert.equal(Number((await q.query("select coalesce(sum(n),0) n from candidate_app_issues where org_id=$1", [orgId])).rows[0].n), batches.length);
  assert.equal(Number((await q.query("select count(*) n from metric_series where org_id<>$1", [orgId])).rows[0].n), 0);
  return { originals: batches.length, sourcePoints: batches.reduce((n, b) => n + b.receipt.accounting.sourcePoints, 0), derivedRows: derived, chargedBytes: totalBytes };
}
