"use strict";
// Authenticated READ-ONLY original-set observation. Never freeze/stop a shared
// Agent. Its owner must keep it alive until this promise returns, then separately
// coordinate all producers before any global drain/stop. No DATA or new lease.
const wire=require("./normal-custody-wire"),{request}=require("./normal-custody-transport");
const MODE="exact-set-read-only-test-v1",MAX_POLLS=20,MAX_MS=10000;
function unknown(records,reason){return {complete:false,reason,scope:MODE,agentStopped:false,journalRetained:true,outcomes:records.map(r=>({localId:r.localId,id:r.id,epoch:r.epoch,population:{...r.population},state:"unconfirmed",stored:false,accounting:null}))};}
function validate(v,records){
 wire.exact(v,["protocol","mode","agentStopped","journalRetained","rows"]);
 if(v.protocol!==wire.PROTOCOL||v.mode!==MODE||v.agentStopped!==false||v.journalRetained!==true||!Array.isArray(v.rows)||v.rows.length!==records.length)wire.fail();
 return records.map((r,i)=>{
  const x=v.rows[i];wire.exact(x,["id","epoch","population","input"]);
  wire.exact(x.population,Object.keys(r.population));
  if(x.id!==r.id||x.epoch!==r.epoch||Object.keys(r.population).some(k=>x.population[k]!==r.population[k]))wire.fail();
  if(x.input===null)return {localId:r.localId,id:r.id,epoch:r.epoch,population:{...r.population},state:"unconfirmed",stored:false,accounting:null};
  const e=wire.input(x.input,r);
  return {localId:r.localId,id:r.id,epoch:r.epoch,population:{...r.population},state:e.state,stored:e.backendStored,accounting:e.backendStored?{...e.accounting}:null};
 });
}
async function observe(records,selection,testing={}){
 const send=testing.request||request,now=testing.now||(()=>performance.now()),sleep=testing.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
 let out=unknown(records,"incomplete");
 if(!records.length||records.length>10||records.some(r=>!r.id||!r.epoch)||new Set(records.map(r=>r.id)).size!==records.length)return unknown(records,"missing-original-identity");
 const inputs=records.map(r=>({id:r.id,epoch:r.epoch,population:{...r.population}}));
 const start=now(),controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),MAX_MS);
 try{
  for(let n=0;n<MAX_POLLS;n++){
   if(controller.signal.aborted||now()-start>=MAX_MS)return {...out,complete:false,reason:"deadline"};
   try{
    const res=await send(selection.normalCustodyUrl,selection.normalCustodyKey,"/barrier",{mode:MODE,inputs},controller.signal);
    if(controller.signal.aborted||res?.status!==200)wire.fail();
    out.outcomes=validate(res.body,records);
    if(out.outcomes.every(x=>x.stored))return {...out,complete:true,reason:"stored-exact-accounting"};
   }catch{ return {...out,complete:false,reason:controller.signal.aborted?"deadline":"unverified-response"}; }
   await sleep(500);
  }
  return {...out,reason:"poll-limit"};
 }finally{clearTimeout(timer);controller.abort();}
}
async function coordinatedShutdown(sdk,exporter,selection,testing={}){
 // Exactly ONE existing reader shutdown, no extra forceFlush/collect/export.
 let failed=false;try{await sdk.shutdown();}catch{failed=true;}
 const records=exporter?.barrierRecords()||[];
 const summary=exporter?.summary();
 if(failed)return unknown(records,"reader-shutdown-failed");
 // Records lost/expired before final snapshot cannot be relabeled delivered.
 if(!summary||summary.backendStored||summary.custodyObserved||summary.unconfirmed||summary.unsent)return unknown(records,"archived-inputs-unverified");
 return observe(records,selection,testing);
}
module.exports={coordinatedShutdown,observe,validate,MODE};
