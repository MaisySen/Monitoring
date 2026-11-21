'use strict';
// Local-only CI acceptance with synthetic data. No stored response bodies/credentials in output.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const product = process.env.PRODUCT_ROOT;
const minutes = Number(process.env.ACCEPTANCE_MINUTES || 180);
assert.ok([5, 180].includes(minutes), 'only bounded smoke or three-hour duration allowed');
const base = process.env.ACCEPTANCE_BASE || 'http://127.0.0.1:4730';
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(base),'acceptance service must be loopback');
const run = `acceptance-${process.env.GITHUB_RUN_ID || Date.now()}`;
const out = process.env.ACCEPTANCE_OUT;
fs.mkdirSync(out, { recursive: true });
const headers = { 'dd-api-key': process.env.API_KEY, 'dd-application-key': process.env.APP_KEY };
const db = (sql) => execFileSync('psql', [process.env.DATABASE_URL, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: 30000 }).trim();
const log = (kind, value) => { const row = { at: new Date().toISOString(), kind, ...value }; fs.appendFileSync(path.join(out, 'evidence.jsonl'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); };
async function api(route, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + '/api' + route, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  assert.equal(r.status, 200, `API status for ${route}`); return r.json();
}
async function heartbeat() {
  const r = await fetch(base + '/otlp/v1/metrics', { method: 'POST', headers: { 'DC-API-KEY': process.env.API_KEY, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000), body: JSON.stringify({resourceMetrics:[{scopeMetrics:[{metrics:[{name:'acceptance.heartbeat',gauge:{dataPoints:[{asDouble:1,timeUnixNano:String(BigInt(Date.now())*1000000n)}]}}]}]}]}) });
  assert.equal(r.status, 200, 'heartbeat intake');
}
const started = Date.now();
let child, aborted = false;
const monitors = [];
async function sample() {
  await heartbeat();
  const now = Math.floor(Date.now()/1000);
  const query = await api('/ui/metrics/query', { queries:[{name:'a',query:'avg:acceptance.heartbeat{*}'}],from:now-180,to:now+1 });
  assert.ok(query.series.some(s=>s.pointlist.some(p=>p[1]===1)), 'query must return current heartbeat');
  const names = await api('/ui/metrics?q=acceptance.heartbeat');
  assert.ok(names.metrics.some(m=>m.metric==='acceptance.heartbeat'&&Number(m.last_seen)>now-120), 'dashboard discovery freshness');
  const hosts = await api('/ui/hosts'); assert.ok(Array.isArray(hosts.hosts));
  const listed = await api('/v1/monitor'); const list=Array.isArray(listed)?listed:listed.monitors;
  const mine = list.filter(m=>monitors.includes(m.id));
  const freshness = JSON.parse(db(`select json_build_object('max_stale_seconds',coalesce(max(extract(epoch from now())-last_evaluated_at/1000.0),0),'evaluated',count(*) filter(where last_evaluated_at is not null)) from monitors where id in (${monitors.join(',')})`));
  if(Date.now()-started>180000) { assert.equal(Number(freshness.evaluated),2); assert.ok(Number(freshness.max_stale_seconds)<120,'monitor evaluation not stalled'); }
  const freeMB=Number(execFileSync('df',['-m','--output=avail',out],{encoding:'utf8'}).trim().split('\n').pop());
  const availableMB=Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo','utf8'))[1])/1024;
  assert.ok(freeMB>=3072,'disk guard: at least3GB free'); assert.ok(availableMB>=512,'memory guard: at least512MB available');
  const rss=Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${process.env.SERVER_PID}/status`,'utf8'))[1])/1024;
  log('sample',{elapsed_s:Math.round((Date.now()-started)/1000),server_rss_mb:Math.round(rss),free_disk_mb:freeMB,available_memory_mb:Math.round(availableMB),monitor_freshness:freshness,monitor_states:mine.map(m=>({id:m.id,state:m.overall_state})),host_count:hosts.hosts.length});
}
(async()=>{
  for(const threshold of [0.5,100]){
    const m=await api('/v1/monitor',{name:`acceptance ${threshold}`,type:'metric alert',query:`avg(last_1m):avg:acceptance.heartbeat{*} > ${threshold}`,message:'Synthetic acceptance test, in-app only',options:{thresholds:{critical:threshold}}});
    assert.ok(m.id);monitors.push(m.id);
  }
  await sample();
  child=spawn(process.execPath,[path.join(product,'bench/scale/loadgen.js')],{env:{...process.env,TARGET:base+'/otlp/v1',MONITORING_API_KEY:process.env.API_KEY,RUN:run,TRACES_PER_S:'20',SECONDS:String(minutes*60),HOSTS:'10',SERVICES:'8',CARDINALITY:'200',CONCURRENCY:'4'},stdio:['ignore','pipe','pipe']});
  let result='',stderr='';child.stdout.on('data',x=>result+=x);child.stderr.on('data',x=>{stderr+=x;fs.appendFileSync(path.join(out,'loadgen.jsonl'),x);});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{if(code===0)resolve();else reject(new Error(`loadgen exit ${code}/${signal}`));});});
  let failure;
  const interval=setInterval(()=>{ if(failure)return; sample().catch(e=>{failure=e;child.kill('SIGTERM');}); },60000);
  try { await done; if(failure)throw failure; } finally {clearInterval(interval);}
  const sent=JSON.parse(result.trim().split('\n').pop());assert.equal(sent.errors,0,'load generator request errors');
  await new Promise(r=>setTimeout(r,30000));await sample();
  const stored=JSON.parse(db(`select json_build_object('spans',(select count(*) from spans where meta->>'loadtest.run'='${run}'),'logs',(select count(*) from logs where tags @> array['loadtest.run:${run}']))`));
  assert.equal(Number(stored.spans),sent.sent.spans,'span sent/stored reconciliation');assert.equal(Number(stored.logs),sent.sent.logs,'log sent/stored reconciliation');
  const listed=await api('/v1/monitor');const list=Array.isArray(listed)?listed:listed.monitors;
  assert.equal(list.find(m=>m.id===monitors[0]).overall_state,'Alert','planted alert');assert.equal(list.find(m=>m.id===monitors[1]).overall_state,'OK','planted normal');
  log('result',{pass:true,source_sha:process.env.ACCEPTANCE_SOURCE_SHA,artifact_run:44878114550,artifact_id:14696432658,requested_minutes:minutes,elapsed_s:Math.round((Date.now()-started)/1000),sent:sent.sent,stored,errors:sent.errors,notes:'Bounded20traces/s synthetic test, not capacity proof; no reboot test.'});
})().catch(e=>{aborted=true;child?.kill('SIGTERM');log('result',{pass:false,elapsed_s:Math.round((Date.now()-started)/1000),reason:e.message});process.exitCode=1;}).finally(async()=>{for(const id of monitors)await api(`/v1/monitor/${id}`,undefined,'DELETE').catch(()=>{});if(aborted)process.exit(1);});
process.once('SIGTERM',()=>{child?.kill('SIGTERM');process.exit(143);});
