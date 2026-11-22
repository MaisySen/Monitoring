"use strict";
// PREPARED ONLY. Real sdk.init, installed NodeSDK/MeterProvider/periodic reader,
// public instrument APIs, forceFlush, accepted exporter/HTTP and shutdown.
const path=require("node:path"),assert=require("node:assert/strict"),readline=require("node:readline");
if(process.env.NORMAL_REAL_C_SOURCE_EXECUTE!=="reviewed-real-agent-c-v1")throw Error("source-only driver gate");
const root=process.argv[2],origin=process.argv[3];
Object.assign(process.env,{
 MONITORING_NODE_APP_CUSTODY:"test-v1",MONITORING_NODE_APP_CUSTODY_SHUTDOWN:"observe-stored-test-v1",MONITORING_NODE_APP_CUSTODY_URL:origin,MONITORING_API_KEY:"a".repeat(32),
 MONITORING_METRIC_DIRECT_TEST_ONLY:"no",MONITORING_METRIC_CUSTODY_TEST_ONLY:"no",
 MONITORING_NODE_APP_CANDIDATE:"off",MONITORING_METRICS_RETRY:"false",MONITORING_LOG_SHIPPING:"false",MONITORING_RUNTIME_METRICS:"false",MONITORING_HANDLE_SIGNALS:"false",MONITORING_FAST_HTTP:"false",
 OTEL_SDK_DISABLED:"false",OTEL_METRIC_EXPORT_INTERVAL:"30000",
 OTEL_METRICS_EXPORTER:"none",OTEL_TRACES_EXPORTER:"none",OTEL_LOGS_EXPORTER:"none",
 OTEL_NODE_ENABLED_INSTRUMENTATIONS:"fs",OTEL_NODE_DISABLED_INSTRUMENTATIONS:"fs",
 OTEL_NODE_EXPERIMENTAL_SDK_METRICS:"false",OTEL_LOG_LEVEL:"none",
});
// Instrumentation packages are loaded by actual init, but their effects must not
// turn this disposable metrics proof into an unrelated process/HTTP export run.
const net=require("node:net"),allowed=new URL(origin),connect=net.Socket.prototype.connect;
// Child effect guard: resolve NO names, contact ONLY this owned Agent endpoint.
// Throws BEFORE the original connect on any accidental trace/log/export target.
let allowedConnections=0,blockedConnections=0;
net.Socket.prototype.connect=require("../normal-custody-init-2026-11-22/endpoint-guard.cjs").guard(origin,connect,ok=>{if(ok)allowedConnections++;else blockedConnections++;});
// Test-only wrapper captures existing safe exporter metadata, no product API change.
const {NormalCustodyExporter}=require(path.join(root,"sdks/node/lib/normal-custody-exporter"));
let metadata=[];
const originalSnapshot=NormalCustodyExporter.prototype.snapshot;
NormalCustodyExporter.prototype.snapshot=function(){metadata=this.barrierRecords();return originalSnapshot.call(this);};
const sdk=require(path.join(root,"sdks/node"));
let notifications=0;
sdk.init({service:"normal-init-source-gate",env:"test",logShipping:false,runtimeMetrics:false,handleSignals:false,fastHttp:false,httpMetrics:false,onNormalCustodyDelivery(){notifications++;}});
const api=require(path.join(root,"sdks/node/node_modules/@opentelemetry/api"));
// All instruments are created AFTER actual NodeSDK registration.
sdk.metrics.increment("init.count",7,{fixture:"normal-init"});
sdk.metrics.gauge("init.gauge",0,{fixture:"normal-init"});
for(const n of [1,5,11])sdk.metrics.histogram("init.histogram",n,{fixture:"normal-init"});
api.metrics.getMeter("normal-init-fixture").createUpDownCounter("init.snapshot").add(-2,{fixture:"normal-init"});
let local;
const report=v=>process.stdout.write(JSON.stringify({...v,seq:++seq,metadata})+"\n");
let seq=0;
const lines=readline.createInterface({input:process.stdin});let chain=Promise.resolve();let stopped=false;let stage="ready";
lines.on("line",line=>{chain=chain.then(async()=>{
 const cmd=JSON.parse(line);stage="command-parse";
 if(cmd.op==="export"){
  stage="force-flush";await sdk.forceFlush();stage="validate-first-observation";const rows=sdk.normalCustodyDelivery.snapshot();assert.equal(rows.length,1);assert.equal(rows[0].acknowledged,true);assert.equal(rows[0].dataAttempts,1);local=rows[0].localId;
  report({op:"export",code:0,row:rows[0],notifications,scope:"actual sdk.init NodeSDK reader public instruments forceFlush"});
 }else if(cmd.op==="recover"){
  stage="receipt-observation";assert.ok(local);await sdk.normalCustodyDelivery.recover(local);report({op:"recover",row:sdk.normalCustodyDelivery.snapshot().find(r=>r.localId===local),notifications});
 }else if(cmd.op==="shutdown"){
  stage="graceful-shutdown";const p=sdk.shutdown();assert.equal(sdk.shutdown(),p);const barrier=await p;stopped=true;
  report({op:"shutdown",barrier,blockedConnections,rows:sdk.normalCustodyDelivery.snapshot(),summary:sdk.normalCustodyDelivery.summary(),notifications,allowedConnections});lines.close();
 }else throw Error("invalid init driver command");
 }).catch(async error=>{
 const category=blockedConnections?"endpoint-guard-refusal":error?.code==="ERR_ASSERTION"?"assertion":"operation-failed";
 report({error:"actual-init-driver-failed",stage,category,allowedConnections,blockedConnections,observations:sdk.normalCustodyDelivery.snapshot()});
 // Emit only reviewed safe categories/observations, never raw error/stderr.
 stage="failure-shutdown";
 try{await sdk.shutdown();report({stage,category:"shutdown-complete",allowedConnections,blockedConnections,observations:sdk.normalCustodyDelivery.snapshot()});}
 catch{report({stage,category:"shutdown-failed",allowedConnections,blockedConnections,observations:sdk.normalCustodyDelivery.snapshot()});}
 stopped=true;process.exitCode=1;lines.close();});});
lines.on("close",()=>chain.then(async()=>{if(!stopped)await sdk.shutdown();}).catch(()=>{process.exitCode=1;}));
report({op:"ready",pid:process.pid,scope:"actual sdk.init; no claim of SDK process-restart identity"});
