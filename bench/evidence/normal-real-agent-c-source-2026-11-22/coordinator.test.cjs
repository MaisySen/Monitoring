"use strict";
// Mock-only integrated-source behavior. No actual fixtures/app/DB/SDK/HTTP imports.
const {test}=require("node:test"),a=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {mergeOriginals,failRetainCleanup,runOwnedScenario}=require("./coordinator.cjs");
const {reconcile,digest}=require("./ownership.cjs");
const root=path.resolve(__dirname,"../../.."),ts=require(path.join(root,"node_modules/typescript/lib/typescript.js"));
function sqlModule(prepared){
 const source=fs.readFileSync(path.join(root,"artifacts/api-server/test/fixtures/normal-agent-real-c-postcommit.ts"),"utf8");
 const out=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const exports={};const load=id=>{
  if(id==="node:assert/strict")return a;if(id==="node:crypto")return require(id);
  if(id.includes("rawAppMetrics"))return {preflightRawAppMetrics(){}};
  if(id.includes("normalAppContract"))return {prepareNormalAppMetrics:()=>prepared};
  if(id.includes("intake/otlp"))return {decodeOtlp:()=>({})};throw Error("mock refused import");
 };
 vm.runInThisContext('(function(exports,require){'+out+'\n})')(exports,load);return exports;
}
const accounting={contract:"node-app-representation-v2-candidate",sourcePoints:1,numberPoints:1,explicitHistogramPoints:0,exponentialHistogramPoints:0,cumulativeSnapshotPoints:0,derivedRows:1};
function fixture(){const bytes=Buffer.from("testbytes"),id="1".repeat(32),receipt={state:"stored",protocol:"monitoring-node-app-service-test-v1",id,sha:digest(bytes),bytes:bytes.length,accounting,durability:"same-tx-synchronous-commit"};return {bytes,id,receipt};}
test("actual postcommit helper accepts only real-query matched accounting and incremental usage",async()=>{
 const b=fixture(),mod=sqlModule({accounting,conversion:{points:[]}});let reads=0;
 const q={async query(sql){reads++;if(sql.includes("join candidate_app_receipts"))return {rows:[{org_id:1,key_id:1,sha:digest(b.bytes),bytes:b.bytes.length,contract:accounting.contract,accounting,durability:b.receipt.durability}]};return {rows:[{rows:1,points:1,bytes:b.bytes.length}]};}};
 const hook=mod.createPostcommitHook(q);await hook(b);a.equal(reads,2);await a.rejects(hook(b));
});
test("postcommit receipt/quota mismatch refuses before drop",async()=>{
 for(const wrong of ["digest","quota"]){const b=fixture(),mod=sqlModule({accounting,conversion:{points:[]}}),q={async query(sql){if(sql.includes("join candidate_app_receipts"))return {rows:[{org_id:1,key_id:1,sha:wrong==="digest"?"0".repeat(64):digest(b.bytes),bytes:b.bytes.length,contract:accounting.contract,accounting,durability:b.receipt.durability}]};return {rows:[{rows:1,points:1,bytes:0}]};}};await a.rejects(mod.createPostcommitHook(q)(b));}
});
test("metadata helper catches foreign org even when series values match",async()=>{
 const mod=sqlModule({conversion:{points:[]}}),q={async query(sql){if(sql.includes("select metric,host")||sql.includes("select name,apps"))return {rows:[]};return {rows:[{n:1}]};}};await a.rejects(mod.verifyMetadataAndIsolation(q,[fixture()]));
});
test("identity join tolerates reordered authenticated Agent rows, refuses missing epoch",()=>{
 const snap=[1,2].map(i=>({id:String(i).repeat(32),epoch:"e".repeat(32),backendStored:true,dataAttempts:1}));
 const metas=snap.map(x=>({...x,sha:"f".repeat(64),length:5,population:{sourcePoints:1}}));
 const obs=snap.map(x=>({...x,population:{sourcePoints:1},input:{...x,sha:"f".repeat(64),bytes:5,backendId:"b".repeat(32)}})).reverse();
 a.equal(mergeOriginals(snap,metas,obs)[0].id,snap[0].id);obs[0].epoch="d".repeat(32);a.throws(()=>mergeOriginals(snap,metas,obs));
});
test("coordinator failure cleanup continues to all owners and never deletes",async()=>{
 const calls=[],p={async stopAndJoin(pid){calls.push(pid);if(pid===1)throw Error("mock join fail");}};
 const r=await failRetainCleanup({children:[{pid:1,exitCode:null},{pid:2,exitCode:null}],processes:p,proxy:{async close(){calls.push("proxy");throw Error("fail");}},server:{async close(){calls.push("server");}}});
 a.deepEqual(calls,[1,2,"proxy","server"]);a.equal(r.retain,true);a.deepEqual(r.failures,["owned-child-unjoined","proxy-unjoined"]);
});
test("real coordinator import is inert and absent release rejects before effects",async()=>{
 const prior=process.env.NORMAL_REAL_C_SOURCE_EXECUTE;delete process.env.NORMAL_REAL_C_SOURCE_EXECUTE;
 try{await a.rejects(runOwnedScenario({}));}finally{if(prior!==undefined)process.env.NORMAL_REAL_C_SOURCE_EXECUTE=prior;}
});
test("barrier identity join tolerates reordered outcomes without negative promotion",()=>{
 const caps=[1,2].map(i=>({id:String(i).repeat(32),bytes:Buffer.from("identical"),receipt:{accounting}}));
 const rows=caps.map((c,i)=>({id:String(i+3).repeat(32),epoch:"e".repeat(32),sdkId:String(i+3).repeat(32),sdkEpoch:"e".repeat(32),sdkBackendStored:i===0,backendStored:i===0,backendId:c.id,sha:digest(c.bytes),length:c.bytes.length,population:{sourcePoints:1,numberPoints:1,explicitHistogramPoints:0,exponentialHistogramPoints:0,cumulativeSnapshotPoints:0},dataAttempts:1}));
 const barrier={agentStopped:false,journalRetained:true,complete:false,reason:"poll-limit",outcomes:rows.map(r=>({id:r.id,epoch:r.epoch,population:r.population,stored:r.backendStored,accounting:r.backendStored?accounting:null})).reverse()};
 a.equal(reconcile(rows,barrier,caps,true).barrierComplete,false);
});

function mockChild(){const {EventEmitter}=require("node:events");return {stdout:new EventEmitter(),stdin:{write(){}}};}
test("concrete role dispatcher binds sequence schema and EOF on owned stream",async()=>{const c=mockChild(),ch=require("./adapters.cjs").childChannel(c);const ready=ch.next("ready",50);c.stdout.emit("data",Buffer.from(JSON.stringify({op:"ready",pid:123,scope:"test",seq:1,metadata:[]})+"\n"));a.equal((await ready).pid,123);c.stdout.emit("end");ch.eof();});
test("concrete dispatcher refuses partial EOF and wrong role without echo",async()=>{const c=mockChild(),ch=require("./adapters.cjs").childChannel(c);const next=ch.next("ready",50);c.stdout.emit("data",Buffer.from("private partial"));c.stdout.emit("end");await a.rejects(next,/raw content suppressed/);a.throws(()=>ch.eof());});
test("concrete dispatcher rejects a private unexpected field",async()=>{const c=mockChild(),ch=require("./adapters.cjs").childChannel(c);const next=ch.next("ready",50);c.stdout.emit("data",Buffer.from(JSON.stringify({op:"ready",pid:123,scope:"test",seq:1,metadata:[],credential:"private"})+"\n"));await a.rejects(next,/raw content suppressed/);});
