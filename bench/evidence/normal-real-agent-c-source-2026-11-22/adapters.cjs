"use strict";
// Concrete Linux/file/HTTP adapters. Import has no effects; construction is gated.
const fs=require("node:fs/promises"),path=require("node:path"),assert=require("node:assert/strict"),http=require("node:http"),net=require("node:net");
const {spawn}=require("node:child_process");
async function identity(pid){const raw=await fs.readFile(`/proc/${pid}/stat`,"utf8"),f=raw.slice(raw.lastIndexOf(")")+2).split(/\s+/);return {ppid:Number(f[1]),pgid:Number(f[2]),start:f[19]};}
async function groupMembers(group){const out=[];for(const name of await fs.readdir("/proc")){if(!/^\d+$/.test(name))continue;try{if((await identity(Number(name))).pgid===group)out.push(Number(name));}catch(e){if(!["ENOENT","ESRCH"].includes(e.code))throw e;}}return out.sort((a,b)=>a-b);}
async function listenerRows(){const rows=[];for(const p of ["/proc/net/tcp","/proc/net/tcp6"]){for(const line of (await fs.readFile(p,"utf8")).trim().split("\n").slice(1)){const f=line.trim().split(/\s+/);if(f[3]==="0A")rows.push({port:parseInt(f[1].split(":").at(-1),16),inode:f[9]});}}return rows;}
function concreteOS(){assert.equal(process.env.NORMAL_REAL_C_SOURCE_EXECUTE,"reviewed-real-agent-c-v1");let group;const exits=new Map();return {
 parentPID:process.pid,get groupID(){assert.ok(group);return group;},async init(){group=(await identity(process.pid)).pgid;assert.equal(group,process.pid,"must be session/group leader created by reviewed foreground supervisor");},identity,
 async ownsListener(pid,port){const rows=(await listenerRows()).filter(x=>x.port===port);if(!rows.length)return false;const links=await fs.readdir(`/proc/${pid}/fd`);const owned=new Set();for(const fd of links){try{owned.add(await fs.readlink(`/proc/${pid}/fd/${fd}`));}catch(e){if(e.code!=="ENOENT")throw e;}}return rows.every(r=>owned.has(`socket:[${r.inode}]`));},
 async portListening(port){return (await listenerRows()).some(x=>x.port===port);},async groupMembers(){return groupMembers(group);},
 async descendants(){
   const ids=[];for(const n of await fs.readdir("/proc")){if(!/^\d+$/.test(n))continue;try{ids.push({pid:Number(n),...(await identity(Number(n)))});}catch(e){if(!["ENOENT","ESRCH"].includes(e.code))throw e;}}
   const family=new Set([process.pid]);let changed=true;while(changed){changed=false;for(const x of ids)if(family.has(x.ppid)&&!family.has(x.pid)){family.add(x.pid);changed=true;}}
   return [...family].filter(x=>x!==process.pid).sort((a,b)=>a-b);
 },
 spawn(argv,options){assert.ok(path.isAbsolute(argv[0]));const child=spawn(argv[0],argv.slice(1),{...options,detached:false,stdio:["pipe","pipe","pipe"]});const done=new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>resolve({code,signal}));});done.catch(()=>{});exits.set(child,done);return child;},
 async gracefulStop(child){child.kill("SIGTERM");},async join(child,ms){let timer;try{return await Promise.race([exits.get(child),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("owned child join deadline")),ms);})]);}finally{clearTimeout(timer);}},
 async backstopOwnedGroup(){throw Error("only outer foreground supervisor owns group backstop; preserve");}
};}
function privateFiles(root){return {
 async read(p){return fs.readFile(path.resolve(root,p));},
 async writeExclusive(p,text,mode){assert.equal(mode,0o600);await fs.writeFile(p,text,{flag:"wx",mode});},
 async make(){const d=await fs.mkdtemp("/tmp/owned-real-agent-c-");await fs.chmod(d,0o700);return d;},
 async removeOwned(d){assert.ok(/^\/tmp\/owned-real-agent-c-[A-Za-z0-9]+$/.test(d));await fs.rm(d,{recursive:true,force:false});},
};}
async function reservePort(){const s=net.createServer();await new Promise((r,j)=>{s.once("error",j);s.listen(0,"127.0.0.1",r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function agentRead(origin,key,route,body,timeoutMs=2000){const u=new URL(origin);assert.equal(u.hostname,"127.0.0.1");assert.equal(u.protocol,"http:");assert.equal(u.pathname,"/");const raw=body===undefined?null:Buffer.from(JSON.stringify(body));return new Promise((resolve,reject)=>{const req=http.request({hostname:u.hostname,port:u.port,path:"/monitoring/candidate/node-app-custody/v1"+route,method:raw?"POST":"GET",agent:false,headers:{"DC-API-KEY":key,...(raw?{"Content-Type":"application/json","Content-Length":raw.length}:{})}},res=>{const parts=[];let n=0;res.on("data",b=>{n+=b.length;if(n>65536){res.destroy();reject(Error("Agent response bound"));}else parts.push(b);});res.on("error",()=>reject(Error("Agent read failed")));res.on("end",()=>{try{assert.equal(res.statusCode,200);assert.equal(res.headers["cache-control"],"no-store");resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));}catch{reject(Error("Agent observation unavailable"));}});});const timer=setTimeout(()=>req.destroy(),timeoutMs);req.once("close",()=>clearTimeout(timer));req.setTimeout(timeoutMs,()=>req.destroy());req.on("error",()=>reject(Error("Agent read unavailable")));req.end(raw);});}
function childChannel(child){let buffer="",seq=0,queue=[],waiter,closed=false,error=false;const fail=()=>{error=true;waiter?.reject(Error("owned child IPC failed; raw content suppressed"));waiter=null;};child.stdout.on("data",chunk=>{buffer+=chunk.toString("utf8");if(Buffer.byteLength(buffer)>65536){fail();return;}let n;while((n=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const m=JSON.parse(line);assert.equal(m.seq,++seq);assert.ok(["ready","export","recover","shutdown"].includes(m.op)&&!m.error);
 const fields={ready:["op","pid","scope","seq","metadata"],export:["op","code","row","notifications","scope","seq","metadata"],recover:["op","row","notifications","seq","metadata"],shutdown:["op","barrier","blockedConnections","rows","summary","notifications","allowedConnections","seq","metadata"]};
 assert.deepEqual(Object.keys(m).sort(),fields[m.op].slice().sort());assert.ok(Array.isArray(m.metadata)&&m.metadata.length<=2);
 if(m.op==="shutdown")assert.ok(Array.isArray(m.rows)&&m.rows.length===2);
 if(waiter){const w=waiter;waiter=null;w.resolve(m);}else{assert.ok(queue.length<4);queue.push(m);}}catch{fail();}}});child.stdout.on("end",()=>{closed=true;if(buffer.length||waiter)fail();});return {
 async next(op,ms){assert.equal(error,false);let timer;try{const m=queue.length?queue.shift():await new Promise((resolve,reject)=>{assert.equal(closed,false);assert.ok(!waiter);waiter={resolve,reject};timer=setTimeout(()=>{waiter=null;reject(Error("owned IPC deadline"));},ms);});assert.equal(m.op,op);return m;}finally{clearTimeout(timer);}},
 async command(op,ms=16000){assert.ok(["export","recover","shutdown"].includes(op));child.stdin.write(JSON.stringify({op})+"\n");return this.next(op,ms);},
 eof(){assert.ok(closed&&!error&&buffer.length===0&&queue.length===0&&!waiter);}
};}
module.exports={concreteOS,privateFiles,reservePort,agentRead,childChannel};
