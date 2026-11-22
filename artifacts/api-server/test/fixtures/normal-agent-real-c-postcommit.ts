import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { preflightRawAppMetrics } from "../../src/lib/rawAppMetrics";
import { prepareNormalAppMetrics } from "../../src/lib/normalAppContract";
import { decodeOtlp } from "../../src/intake/otlp";
import type { CapturedBatch } from "./normal-agent-real-c-oracle";
type Query = { query(sql: string, values?: any[]): Promise<{ rows: any[] }> };

// Called only after actual C200 stored, before proxy can drop it. No effects at
// module load. Exact byte hash/receipt persisted by real C, never test inserts.
export function createPostcommitHook(q: Query) {
  let previousRows=0,previousPoints=0,previousBytes=0;
  const originals = new Set<string>();
  return async (batch: CapturedBatch) => {
    assert.equal(originals.has(batch.id),false);assert.ok(originals.size<2);
    preflightRawAppMetrics(batch.bytes);
    const p=prepareNormalAppMetrics(1,decodeOtlp("metrics",batch.bytes,"application/x-protobuf"));
    const rows=(await q.query("select l.org_id,l.key_id,l.sha,l.bytes,l.contract,r.accounting,r.durability from candidate_app_leases l join candidate_app_receipts r on r.id=l.id where l.id=$1",[batch.id])).rows;
    assert.equal(rows.length,1);const x=rows[0];
    assert.equal(x.org_id,1);assert.equal(x.key_id,1);assert.equal(x.sha,createHash("sha256").update(batch.bytes).digest("hex"));
    assert.equal(x.bytes,batch.bytes.length);assert.equal(x.contract,p.accounting.contract);
    assert.deepEqual(x.accounting,p.accounting);assert.equal(x.durability,"same-tx-synchronous-commit");
    assert.deepEqual(batch.receipt,{state:"stored",protocol:"monitoring-node-app-service-test-v1",id:batch.id,sha:x.sha,bytes:x.bytes,accounting:x.accounting,durability:x.durability});
    const state=(await q.query("select (select count(*) from metric_points) rows,(select coalesce(sum(points),0) from org_usage_daily where org_id=1) points,(select coalesce(sum(bytes),0) from org_usage_minute where org_id=1) bytes")).rows[0];
    assert.equal(Number(state.rows)-previousRows,p.accounting.derivedRows);
    assert.equal(Number(state.points)-previousPoints,p.accounting.derivedRows);
    assert.equal(Number(state.bytes)-previousBytes,batch.bytes.length);
    previousRows=Number(state.rows);previousPoints=Number(state.points);previousBytes=Number(state.bytes);originals.add(batch.id);
  };
}

// First integration only tests isolation from SQL, not extra HTTP auth probes
// that would change the exact intended Agent call inventory.
export async function verifyMetadataAndIsolation(q: Query,batches: CapturedBatch[]) {
  const expectedSeries=new Map<string,any>();
  const expectedHosts=new Map<string,Set<string>>();
  const ignored=new Set(["system","trace","service_check","datadog","monitoring","runtime","otelcol"]);
  for(const b of batches){
    const prepared=prepareNormalAppMetrics(1,decodeOtlp("metrics",b.bytes,"application/x-protobuf"));
    for(const p of prepared.conversion.points){
      const tags=[...new Set(p.tags.filter(Boolean).map(String).map(t=>t.trim()).filter(t=>t&&!t.startsWith("host:")))].sort();
      const key=JSON.stringify([p.metric,p.host,tags.join(",")]);
      expectedSeries.set(key,[p.metric,p.host,tags,tags.join(","),p.type,p.unit??null]);
      if(p.host){if(!expectedHosts.has(p.host))expectedHosts.set(p.host,new Set());const app=p.metric.split(".")[0];if(app&&!ignored.has(app))expectedHosts.get(p.host)!.add(app);}
    }
  }
  const series=(await q.query("select metric,host,tags,tags_key,type,unit from metric_series where org_id=1")).rows;
  const normalize=(xs:any[])=>xs.map(x=>JSON.stringify(x)).sort();
  assert.deepEqual(normalize(series.map(x=>[x.metric,x.host,x.tags,x.tags_key,x.type,x.unit])),normalize([...expectedSeries.values()]));
  const hosts=(await q.query("select name,apps,os,platform,agent_version,tags from hosts where org_id=1")).rows;
  assert.deepEqual(normalize(hosts.map(x=>[x.name,[...x.apps].sort(),x.os,x.platform,x.agent_version,x.tags])),normalize([...expectedHosts].map(([host,apps])=>[host,[...apps].sort(),null,null,null,[]])));
  for(const table of ["metric_series","hosts","org_usage_daily","org_usage_minute","candidate_app_leases","candidate_app_issues"]){
    assert.equal(Number((await q.query(`select count(*) n from ${table} where org_id<>1`)).rows[0].n),0);
  }
  assert.equal(Number((await q.query("select count(*) n from candidate_app_leases where key_id<>1")).rows[0].n),0);
  assert.equal(Number((await q.query("select count(*) n from metric_points p left join metric_series s on s.id=p.series_id where s.id is null or s.org_id<>1")).rows[0].n),0);
  assert.equal(Number((await q.query("select count(*) n from candidate_app_receipts r left join candidate_app_leases l on l.id=r.id where l.id is null or l.org_id<>1")).rows[0].n),0);
}
