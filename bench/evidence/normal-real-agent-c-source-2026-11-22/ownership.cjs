"use strict";
// Dependency-injected source controller. No imports of pg/app/SDK and no launcher.
const assert=require("node:assert/strict"),crypto=require("node:crypto");
const digest=b=>crypto.createHash("sha256").update(b).digest("hex");
const dbName=n=>{assert.match(n,/^candidate_agent_[a-f0-9]{20}$/);return n;};
class OwnedDatabase {
  constructor(admin,name){this.admin=admin;this.name=dbName(name);this.oid=null;this.created=false;this.closed=false;}
  async create(){
    assert.equal(this.created,false);assert.equal(this.closed,false);
    assert.equal((await this.admin.query("select oid from pg_database where datname=$1",[this.name])).rows.length,0,"never adopt existing DB");
    // Name is strict generated identifier, never arbitrary SQL input.
    await this.admin.query('create database "'+this.name+'"');this.created=true;
    const r=(await this.admin.query("select oid::bigint oid from pg_database where datname=$1",[this.name])).rows;
    assert.equal(r.length,1);this.oid=Number(r[0].oid);assert.ok(Number.isSafeInteger(this.oid)&&this.oid>0);
    return {name:this.name,oid:this.oid};
  }
  async finish({successful,negative,resourcesJoined}){
    assert.equal(this.closed,false);this.closed=true;
    if(!successful||negative||!resourcesJoined)return {retained:true};
    assert.equal(this.created,true);assert.ok(this.oid);
    const r=(await this.admin.query("select oid::bigint oid from pg_database where datname=$1",[this.name])).rows;
    assert.equal(r.length,1);assert.equal(Number(r[0].oid),this.oid,"OID identity mismatch, preserve");
    assert.equal((await this.admin.query("select pid from pg_stat_activity where datid=$1",[this.oid])).rows.length,0,"no force termination/drop");
    await this.admin.query('drop database "'+this.name+'"');
    assert.equal((await this.admin.query("select oid from pg_database where datname=$1",[this.name])).rows.length,0);
    return {retained:false};
  }
}
class OwnedProcesses {
  constructor(os){this.os=os;this.children=new Map();this.ports=new Set();this.failed=false;}
  // os is trusted platform adapter, not child IPC claims. No detached spawn here.
  async record(child){
    assert.ok(Number.isSafeInteger(child.pid)&&child.pid>1);assert.ok(!this.children.has(child.pid));
    const x=await this.os.identity(child.pid);assert.equal(x.ppid,this.os.parentPID);assert.equal(x.pgid,this.os.groupID);
    this.children.set(child.pid,{child,start:x.start,joined:false,seq:0});
  }
  async ipc(pid,message){
    const x=this.children.get(pid);assert.ok(x&&!x.joined);
    const id=await this.os.identity(pid);assert.equal(id.start,x.start);assert.equal(id.pgid,this.os.groupID);
    assert.equal(typeof message,"object");assert.ok(message!==null);assert.equal(message.seq,++x.seq);
    assert.ok(["ready","result","closed"].includes(message.kind));
    if(message.kind==="ready"){
      assert.ok(Number.isInteger(message.port)&&message.port>0&&message.port<65536);
      assert.equal(this.ports.has(message.port),false);
      assert.equal(await this.os.ownsListener(pid,message.port),true);this.ports.add(message.port);
    }
    return message;
  }
  async joinExited(pid){
    const x=this.children.get(pid);assert.ok(x&&!x.joined);
    const exit=await this.os.join(x.child,2000);assert.equal(exit.signal,null);assert.equal(exit.code,0);x.joined=true;
  }
  async ownPort(pid,port){assert.equal(await this.os.ownsListener(pid,port),true);assert.equal(this.ports.has(port),false);this.ports.add(port);}
  async stopAndJoin(pid){
    const x=this.children.get(pid);assert.ok(x&&!x.joined&&!x.stopAttempted);x.stopAttempted=true;
    const id=await this.os.identity(pid);assert.equal(id.start,x.start);assert.equal(id.pgid,this.os.groupID);
    await this.os.gracefulStop(x.child);const exit=await this.os.join(x.child,8000);
    assert.equal(exit.signal,null);assert.equal(exit.code,0);x.joined=true;
  }
  async verify(){
    assert.ok([...this.children.values()].every(x=>x.joined));
    for(const p of this.ports)assert.equal(await this.os.portListening(p),false);
    assert.deepEqual(await this.os.descendants(),[]);
    // Controller remains in group. Exclude its own PID, never unrelated PGIDs.
    assert.deepEqual((await this.os.groupMembers()).filter(p=>p!==this.os.parentPID),[]);
    return true;
  }
  async timeout(){
    this.failed=true;
    // Adapter must revalidate exact supervisor-owned group before signal.
    await this.os.backstopOwnedGroup();return {failed:true,retain:true};
  }
}
async function verifyHashes(io,inventory,binary){
  assert.equal(binary.sourceCommit,inventory.commit);assert.match(binary.sha256,/^[a-f0-9]{64}$/);
  assert.equal(binary.fullFactoryCompilePassed,true,"not reduced/stub package");
  for(const f of inventory.files){assert.ok(!f.path.includes("..")&&!f.path.startsWith("/"));assert.equal(digest(await io.read(f.path)),f.sha256);}
  assert.equal(digest(await io.read(binary.path)),binary.sha256);
}
function safeResult(value,secrets){
  // Explicit output projection rather than publishing arbitrary child data.
  const result={version:1,status:value.status,mode:value.mode,barrierComplete:value.barrierComplete,originals:value.originals,sourcePoints:value.sourcePoints,derivedRows:value.derivedRows,chargedBytes:value.chargedBytes,resourcesJoined:value.resourcesJoined,retained:value.retained};
  assert.ok(["pass","incomplete","failed"].includes(result.status));assert.ok(["happy","lost-final-response","withheld-final-evidence"].includes(result.mode));
  if(result.mode==="withheld-final-evidence")assert.equal(result.barrierComplete,false);
  for(const k of ["originals","sourcePoints","derivedRows","chargedBytes"])assert.ok(Number.isSafeInteger(result[k])&&result[k]>=0);
  for(const k of ["barrierComplete","resourcesJoined","retained"])assert.equal(typeof result[k],"boolean");
  if(result.status==="pass")assert.ok(result.barrierComplete&&result.resourcesJoined&&!result.retained);
  const text=JSON.stringify(result);
  for(const s of secrets){assert.equal(typeof s,"string");assert.ok(s.length>=8);assert.ok(!text.includes(s),"secret scan refusal");}
  assert.ok(!/(postgres(?:ql)?:\/\/|credential|api_key|base64|stack|Buffer)/i.test(text));
  return text+"\n";
}
async function writeSafeResult(io,path,value,secrets){const text=safeResult(value,secrets);await io.writeExclusive(path,text,0o600);return digest(text);}
function reconcile(rows,barrier,captured,negative){
  // rows are SDK snapshot plus barrierRecords and authenticated Agent input
  // view, merged only after matching the same id+epoch. Not raw SDK snapshot.
  assert.equal(rows.length,2);assert.equal(captured.length,2);assert.equal(barrier.outcomes.length,2);
  assert.equal(new Set(rows.map(x=>x.id)).size,2);assert.equal(new Set(captured.map(x=>x.id)).size,2);
  assert.equal(barrier.agentStopped,false);assert.equal(barrier.journalRetained,true);
  rows.forEach((r,i)=>{
    assert.match(r.id,/^[a-f0-9]{32}$/);assert.match(r.epoch,/^[a-f0-9]{32}$/);assert.equal(r.dataAttempts,1);
    const b=captured.find(x=>x.id===r.backendId);assert.ok(b);assert.equal(r.sha,digest(b.bytes));assert.equal(r.length,b.bytes.length);
    assert.equal(r.sdkId,r.id);assert.equal(r.sdkEpoch,r.epoch);if(r.sdkBackendStored)assert.equal(r.backendStored,true);
    const matches=barrier.outcomes.filter(o=>o.id===r.id&&o.epoch===r.epoch);assert.equal(matches.length,1);const o=matches[0];assert.equal(o.id,r.id);assert.equal(o.epoch,r.epoch);assert.deepEqual(o.population,r.population);
    for(const k of Object.keys(r.population))assert.equal(r.population[k],b.receipt.accounting[k]);
    if(negative&&i===1){assert.equal(r.backendStored,false);assert.equal(o.stored,false);assert.equal(o.accounting,null);}
    else {assert.equal(r.backendStored,true);assert.equal(o.stored,true);assert.deepEqual(o.accounting,b.receipt.accounting);}
  });
  assert.equal(barrier.complete,!negative);
  if(!negative)assert.equal(barrier.reason,"stored-exact-accounting");else assert.ok(["deadline","poll-limit"].includes(barrier.reason));
  return {originals:2,barrierComplete:barrier.complete};
}
function ipcParser(onMessage){
  let text="",sequence=0,failed=false;
  const decoder=new (require("node:string_decoder").StringDecoder)("utf8");
  return chunk=>{
    assert.equal(failed,false);
    try{
      text+=decoder.write(chunk);assert.ok(Buffer.byteLength(text)<=65536);
      let n;while((n=text.indexOf("\n"))!==-1){
        const line=text.slice(0,n);text=text.slice(n+1);assert.ok(line.length>0);
        const m=JSON.parse(line);assert.ok(m&&typeof m==="object"&&!Array.isArray(m));
        assert.equal(m.seq,++sequence);assert.ok(["ready","result","closed"].includes(m.kind));onMessage(m);
      }
    }catch{failed=true;throw Error("owned IPC framing refused; raw content suppressed");}
  };
}
module.exports={OwnedDatabase,OwnedProcesses,verifyHashes,safeResult,writeSafeResult,reconcile,digest,ipcParser};
