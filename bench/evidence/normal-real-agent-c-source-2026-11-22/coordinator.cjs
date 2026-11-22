"use strict";
// Integrated source workflow. NO top-level execution, no automatic CLI launcher.
// External runtime release, completed real binary and PG authority still absent.
const assert=require("node:assert/strict"),path=require("node:path"),crypto=require("node:crypto"),fs=require("node:fs/promises");
const {OwnedDatabase,OwnedProcesses,verifyHashes,writeSafeResult,reconcile}=require("./ownership.cjs");
const {concreteOS,privateFiles,reservePort,agentRead,childChannel}=require("./adapters.cjs");
const {createRealCProxy}=require("./real-c-proxy.cjs");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function relativePath(p){assert.equal(typeof p,"string");assert.ok(p.length>0&&!path.isAbsolute(p)&&!p.includes("..")&&!p.includes("\\")&&!p.includes("\0"));return p;}
async function recoverAttestation(root,attestationPath,read=fs.readFile){
  // A future independently accepted build must produce this machine record.
  // Existing incomplete compile logs cannot satisfy it. No boolean override.
  const a=JSON.parse(await read(attestationPath,"utf8"));
  assert.equal(a.status,"FULL_REAL_FACTORY_LINK_ACCEPTED");assert.equal(a.testsExecuted,false);assert.equal(a.binaryExecuted,false);
  assert.deepEqual(a.buildFlags,["-p","1","-mod=readonly","-trimpath","-tags","grpcnotrace"]);
  assert.match(a.reviewedSourceCommit,/^[a-f0-9]{40}$/);assert.match(a.binarySHA256,/^[a-f0-9]{64}$/);
  assert.match(a.compileLogSHA256,/^[a-f0-9]{64}$/);assert.match(a.factoryInventorySHA256,/^[a-f0-9]{64}$/);assert.match(a.sourceInventorySHA256,/^[a-f0-9]{64}$/);assert.match(a.nodeClosureSHA256,/^[a-f0-9]{64}$/);
  for(const k of ["compileLogPath","factoryInventoryPath","sourceInventoryPath","binaryPath","nodeClosurePath"])relativePath(a[k]);
  const files={read:p=>read(path.resolve(root,relativePath(p)))},hash=b=>crypto.createHash("sha256").update(b).digest("hex");
  assert.equal(hash(await files.read(a.compileLogPath)),a.compileLogSHA256);
  assert.equal(hash(await files.read(a.factoryInventoryPath)),a.factoryInventorySHA256);
  const inventoryBytes=await files.read(a.sourceInventoryPath);
  assert.equal(hash(inventoryBytes),a.sourceInventorySHA256,"source inventory anchored by attestation");
  const inventory=JSON.parse(inventoryBytes.toString("utf8"));
  // Schema: top-level "commit" is the reviewed source commit. The older baseline-style
  // inventory (key "baseline") deliberately cannot satisfy this check.
  assert.equal(inventory.commit,a.reviewedSourceCommit);
  const closureBytes=await files.read(a.nodeClosurePath);
  assert.equal(hash(closureBytes),a.nodeClosureSHA256,"node dependency closure anchored by attestation");
  await verifyNodeClosure(files,JSON.parse(closureBytes.toString("utf8")),a.reviewedSourceCommit,hash);
  await verifyHashes(files,inventory,{sourceCommit:a.reviewedSourceCommit,sha256:a.binarySHA256,path:a.binaryPath,fullFactoryCompilePassed:true});
  return {binary:path.resolve(root,a.binaryPath),sourceCommit:a.reviewedSourceCommit};
}
async function verifyNodeClosure(files,m,commit,hash){
  // Ordinary manifest: every file of the tsx/esbuild/pg (+sdk api) executing closure, by sha256.
  // Produced from the installed tree by gen_node_closure.py; never from the network.
  assert.equal(m.schema,"node-closure-v1");assert.equal(m.commit,commit);assert.match(m.lockfileSHA256,/^[a-f0-9]{64}$/);
  const names=new Set((m.packages||[]).map(x=>x.name));
  for(const n of ["tsx","esbuild","pg","express","drizzle-orm","pino","protobufjs","@opentelemetry/api","@opentelemetry/sdk-node"])assert.ok(names.has(n),"closure lacks "+n);
  assert.ok((m.files||[]).some(f=>/(^|\/)@esbuild\/[^/]+\/bin\/esbuild$/.test(f.path)),"esbuild platform executable missing");
  assert.equal(hash(await files.read("pnpm-lock.yaml")),m.lockfileSHA256);assert.equal(hash(await files.read("sdks/node/package-lock.json")),m.sdkLockfileSHA256);
  for(const f of m.files){relativePath(f.path);assert.match(f.sha256,/^[a-f0-9]{64}$/);assert.equal(hash(await files.read(f.path)),f.sha256);}
}
function mergeOriginals(snapshot,metadata,agentRows){
  assert.equal(snapshot.length,2);assert.equal(metadata.length,2);assert.equal(agentRows.length,2);
  return snapshot.map(s=>{
    const ms=metadata.filter(m=>m.id===s.id&&m.epoch===s.epoch);assert.equal(ms.length,1);
    const as=agentRows.filter(a=>a.id===s.id&&a.epoch===s.epoch);assert.equal(as.length,1);const m=ms[0],a=as[0];
    assert.deepEqual(a.population,m.population);assert.ok(a.input);assert.equal(a.input.id,s.id);assert.equal(a.input.epoch,s.epoch);
    assert.equal(a.input.sha,m.sha);assert.equal(a.input.bytes,m.length);
    return {...m,...s,backendId:a.input.backendId,backendStored:a.input.backendStored,sdkId:s.id,sdkEpoch:s.epoch,sdkBackendStored:s.backendStored};
  });
}
async function failRetainCleanup({children,processes,proxy,server}){
  // Shared by real workflow and inert orchestration failure tests. No retry,
  // DB deletion, path removal, recovery command or next scenario here.
  const failures=[];
  for(const child of children)if(child&&child.exitCode===null){try{await processes.stopAndJoin(child.pid);}catch{failures.push("owned-child-unjoined");}}
  try{if(proxy)await proxy.close();}catch{failures.push("proxy-unjoined");}
  try{if(server)await server.close();}catch{failures.push("server-unjoined");}
  return {retain:true,failures};
}
function childEnvironment(role,source=process.env){
  assert.ok(["agent","sdk"].includes(role));
  const out={};for(const key of ["PATH","HOME","TMPDIR","LANG","LC_ALL","TZ","SYSTEMROOT"]){if(typeof source[key]==="string")out[key]=source[key];}
  out.NORMAL_REAL_C_SOURCE_EXECUTE="reviewed-real-agent-c-v1";
  return out;
}
async function concreteAdmin(root,adminURL){
  const {createRequire}=require("node:module"),req=createRequire(path.join(root,"lib/db/package.json"));
  const {Pool}=req("pg"),p=new Pool({connectionString:adminURL,max:1,connectionTimeoutMillis:500,options:"-c statement_timeout=3000 -c lock_timeout=1000"});p.on("error",()=>{});return p;
}
async function concreteFixtures(root){
  const s=await import(path.join(root,"artifacts/api-server/test/fixtures/normal-agent-real-c-server.ts"));
  const o=await import(path.join(root,"artifacts/api-server/test/fixtures/normal-agent-real-c-oracle.ts"));
  const h=await import(path.join(root,"artifacts/api-server/test/fixtures/normal-agent-real-c-postcommit.ts"));return {...s,...o,...h};
}
function createCoordinator(overrides={}){
  // One small dependency seam, defaults are the same concrete workflow. Tests
  // replace boundary effects, not the phase ordering, cleanup or ownership.
  const d={recoverAttestation,concreteOS,privateFiles,reservePort,agentRead,childChannel,createRealCProxy,sleep,now:()=>Date.now(),admin:concreteAdmin,fixtures:concreteFixtures,setEnv:v=>Object.assign(process.env,v),...overrides};
  let used=false;
  return async function runOwnedScenario({root,mode,adminURL,attestationPath,resultPath}){

  assert.equal(process.env.NORMAL_REAL_C_SOURCE_EXECUTE,"reviewed-real-agent-c-v1");
  assert.ok(["happy","lost-final-response","withheld-final-evidence"].includes(mode));
  assert.equal(process.env.NORMAL_REAL_C_PG_AUTHORITY,"owned-local-create-drop-reviewed");
  assert.equal(used,false,"fresh coordinator process per scenario; never reuse app/pool modules");used=true;
  const au=new URL(adminURL);assert.ok(["127.0.0.1","[::1]"].includes(au.hostname));assert.ok(["postgres:","postgresql:"].includes(au.protocol));
  const attestation=await d.recoverAttestation(root,attestationPath); // before DB/children
  const os=d.concreteOS();await os.init();const processes=new OwnedProcesses(os),files=d.privateFiles(root);
  const admin=await d.admin(root,adminURL);
  const secrets=new Set(["a".repeat(32),adminURL]);
  const db=new OwnedDatabase(admin,"candidate_agent_"+crypto.randomBytes(10).toString("hex"));
  let work,workRetained=false,server,proxy,agent,sdk,channel,success=false,joined=false,databaseRetained=true,sql={sourcePoints:0,derivedRows:0,chargedBytes:0},barrierComplete=false;
  let result={status:"failed",mode,barrierComplete:false,originals:0,sourcePoints:0,derivedRows:0,chargedBytes:0,resourcesJoined:false,retained:true};
  const capturedLogs=[];let logBytes=0;
  const capture=child=>{
    const save=(stream,role)=>{stream.on("data",b=>{const left=65536-logBytes;if(left>0){const part=Buffer.from(b).subarray(0,left);capturedLogs.push(part);logBytes+=part.length;}if(b.length>left)processes.failed=true;});};
    save(child.stderr,"stderr");save(child.stdout,"stdout");
  };
  try{
    const owned=await db.create();
    const scratch=new URL(adminURL);scratch.pathname="/"+owned.name;secrets.add(scratch.toString());
    d.setEnv({DATABASE_URL:scratch.toString(),NODE_ENV:"test",SESSION_SECRET:"",MONITORING_NODE_APP_CANDIDATE:"test-v1",MONITORING_STORAGE:"postgres",MONITORING_BACKGROUND_JOBS:"false",MONITORING_SYNCHRONOUS_COMMIT:"on",PINO_LOG_LEVEL:"silent"});
    // Requires launch with already-installed tsx loader; imports only after gates.
    const {startNormalAgentRealC,verifyNormalAgentRealC,createPostcommitHook,verifyMetadataAndIsolation}=await d.fixtures(root);
    server=await startNormalAgentRealC(owned.name,owned.oid);
    const sp=Number(new URL(server.origin).port);await processes.ownPort(process.pid,sp);
    proxy=d.createRealCProxy({upstream:server.origin,mode,onCommittedStored:createPostcommitHook(server),onSecret:s=>secrets.add(s)});
    await new Promise((r,j)=>{proxy.server.once("error",j);proxy.server.listen(0,"127.0.0.1",r);});
    const pp=proxy.server.address().port;await processes.ownPort(process.pid,pp);
    work=await files.make();workRetained=true;const port=await d.reservePort(),origin="http://127.0.0.1:"+port;
    const config=path.join(work,"input.yaml");
    await files.writeExclusive(config,`api_key: ${"a".repeat(32)}\nurl: http://127.0.0.1:${pp}\nstate_dir: ${work}/journal\nhost_metrics: {enabled: false}\napm: {otlp: false, datadog_compat: false}\ndogstatsd: {enabled: false}\nlogs: []\ndebug: false\nnormal_metric_custody_test:\n  mode: test-v1\n  endpoint: 127.0.0.1:${port}\n`,0o600);
    // Rehash immediately before use, not just when planning.
    await d.recoverAttestation(root,attestationPath);
    agent=os.spawn([attestation.binary,"run","-c",config],{cwd:root,env:childEnvironment("agent")});capture(agent);await processes.record(agent);
    let ready=false;const readyDeadline=d.now()+7800;while(d.now()<readyDeadline){if(agent.exitCode!==null)break;try{const c=await d.agentRead(origin,"a".repeat(32),"/capabilities",undefined,200);assert.equal(c.agentJournal,true);assert.equal(c.exclusiveModeRequired,true);ready=true;break;}catch{await d.sleep(50);}}
    assert.equal(ready,true,"bind/startup fail retains, no endpoint retry");await processes.ownPort(agent.pid,port);
    sdk=os.spawn([process.execPath,path.join(__dirname,"sdk-driver.cjs"),root,origin],{cwd:root,env:childEnvironment("sdk")});capture(sdk);await processes.record(sdk);channel=d.childChannel(sdk);const sdkReady=await channel.next("ready",8000);assert.equal(sdkReady.pid,sdk.pid);
    const first=await channel.command("export",8000);const initial={id:first.row.id,epoch:first.row.epoch};
    let stored=false;for(let i=0;i<12;i++){const r=await channel.command("recover",2000);assert.equal(r.row.id,initial.id);assert.equal(r.row.epoch,initial.epoch);if(r.row.backendStored){stored=true;break;}await d.sleep(250);}assert.equal(stored,true);
    const final=await channel.command("shutdown",16000);assert.equal(final.blockedConnections,0);
    assert.equal(final.rows[0].id,initial.id);assert.equal(final.rows[0].epoch,initial.epoch);
    const observations=await d.agentRead(origin,"a".repeat(32),"/barrier",{mode:"exact-set-read-only-test-v1",inputs:final.metadata.map(m=>({id:m.id,epoch:m.epoch,population:m.population}))});
    assert.equal(observations.protocol,"monitoring-node-app-custody-test-v1");assert.equal(observations.mode,"exact-set-read-only-test-v1");assert.equal(observations.agentStopped,false);assert.equal(observations.journalRetained,true);
    const rows=mergeOriginals(final.rows,final.metadata,observations.rows),caps=proxy.captured(),negative=mode==="withheld-final-evidence";
    const reconciled=reconcile(rows,final.barrier,caps,negative);barrierComplete=reconciled.barrierComplete;
    const status=proxy.safeStatus();assert.equal(status.refused,false);assert.deepEqual([status.counts.capabilities,status.counts.lease,status.counts.metrics,status.distinctDATA,status.verifiedCommits],[2,2,2,2,2]);
    if(mode==="happy")assert.equal(status.counts.receipt,0);else assert.ok(status.counts.receipt>=1&&status.counts.receipt<=6);
    sql=await verifyNormalAgentRealC(server,1,caps);await verifyMetadataAndIsolation(server,caps);
    sdk.stdin.end();await processes.joinExited(sdk.pid);await d.sleep(10);channel.eof();
    await d.agentRead(origin,"a".repeat(32),"/capabilities");
    await processes.stopAndJoin(agent.pid);
    const closingProxy=proxy;proxy=null;await closingProxy.close();const closingServer=server;server=null;await closingServer.close();
    joined=await processes.verify();assert.equal(processes.failed,false);
    success=!negative;
    result={status:negative?"incomplete":"pass",mode,barrierComplete,originals:2,...sql,resourcesJoined:joined,retained:negative};
  }catch{
    // No repair/retry or DATA synthesis. Stop only exact tracked child instances.
    const cleanup=await failRetainCleanup({children:[sdk,agent],processes,proxy,server});
    if(cleanup.failures.length)processes.failed=true;
    success=false;result={...result,status:"failed",retained:true};
  }finally{
    try{const retention=await db.finish({successful:success,negative:mode==="withheld-final-evidence",resourcesJoined:joined});databaseRetained=retention.retained;result.retained=retention.retained;}
    catch{result.status="failed";result.retained=true;}
    try{await admin.end();}catch{result.status="failed";result.retained=true;}
  }
  if(result.status!=="failed"&&!databaseRetained&&work){
    try{await files.removeOwned(work);workRetained=false;}catch{result.status="failed";result.retained=true;}
  }
  // Never publish raw logs, DSN, wire, exceptions, credential-bearing responses.
  // Known terms collected for defensive scanning; private logs never serialized.
  let diagnostics=null;
  if(result.status==="failed"&&workRetained&&capturedLogs.length){
    diagnostics=path.join(work,"failure-private.log");
    try{await files.writeExclusive(diagnostics,Buffer.concat(capturedLogs),0o600);}catch{diagnostics=null;result.status="failed";result.retained=true;}
  }
  let resultWritten=false;
  try{await writeSafeResult(files,resultPath,result,[...secrets]);resultWritten=true;}
  catch{
    result.status="failed";result.retained=true;
    // Output failure after successful resource cleanup is still a failure.
    // Recover a fresh private diagnostics directory, never recreate DB/journal.
    if(!workRetained){try{work=await files.make();workRetained=true;}catch{}}
    if(workRetained&&!diagnostics&&capturedLogs.length){try{diagnostics=path.join(work,"failure-private.log");await files.writeExclusive(diagnostics,Buffer.concat(capturedLogs),0o600);}catch{diagnostics=null;}}
  }
  return {result,resultWritten,retained:result.retained?{database:databaseRetained?db.name:null,oid:databaseRetained?db.oid:null,directory:workRetained?work:null,diagnostics}:null};
  };
}
const runOwnedScenario=createCoordinator();
module.exports={verifyNodeClosure,runOwnedScenario,createCoordinator,recoverAttestation,mergeOriginals,failRetainCleanup,relativePath,childEnvironment};
