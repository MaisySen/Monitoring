"use strict";
// PREPARED SOURCE ONLY. Import is inert. Caller owns the one allowed upstream,
// listener, deadline, exact child group, journals, scratch DB and retained evidence.
const http = require("node:http"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const prefix = "/otlp/candidate/node-app/v1";
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function createRealCProxy({upstream, mode, onCommittedStored, onSecret=()=>{}}) {
  const target = new URL(upstream);
  assert.equal(target.protocol,"http:"); assert.equal(target.hostname,"127.0.0.1");
  assert.match(target.port,/^[0-9]+$/); assert.equal(target.pathname,"/");
  assert.equal(target.search,""); assert.equal(target.hash,""); assert.equal(target.username,""); assert.equal(target.password,"");
  assert.ok(["happy","lost-final-response","withheld-final-evidence"].includes(mode));
  assert.equal(typeof onCommittedStored,"function");
  const counts={capabilities:0,lease:0,metrics:0,receipt:0}, captures=[], requests=new Set(), sockets=new Set(), pending=new Set();
  let finalId, dropped=0, verified=0, refused=false, closing=false;
  const fail=(res)=>{refused=true;res.destroy();}; // never manufacture acceptance/error JSON
  const handler=(req,res)=>{
    if(closing){req.destroy();return;}
    const method=req.method,path=req.url;
    for(const k of ["dc-api-key","x-monitoring-delivery-credential"]){const v=req.headers[k];if(typeof v==="string")onSecret(v);}
    const kind=path?.startsWith(prefix+"/")?path.slice(prefix.length+1):"";
    if(!Object.hasOwn(counts,kind)||method!==(kind==="capabilities"?"GET":"POST")){fail(res);req.resume();return;}
    if(++counts[kind]>({capabilities:2,lease:2,metrics:2,receipt:6})[kind]){fail(res);req.resume();return;}
    if(requests.size>=1){fail(res);req.resume();return;}
    const parts=[];let n=0,forward,invalid=false;
    const timer=setTimeout(()=>{invalid=true;forward?.destroy();fail(res);req.destroy();},6500);
    res.once("close",()=>clearTimeout(timer));
    req.on("data",b=>{n+=b.length;if(n>(kind==="metrics"?1048576:1024)){invalid=true;fail(res);req.destroy();return;}parts.push(b);});
    req.on("error",()=>{forward?.destroy();fail(res);});
    req.on("end",()=>{
      if(invalid||closing)return;
      const body=Buffer.concat(parts,n);
      // Preserve raw header names/values and duplicates. Only Host/Connection
      // are replaced for this hop. C, not this proxy, validates authentication.
      const headers=[];
      for(let i=0;i<req.rawHeaders.length;i+=2)if(!["host","connection"].includes(req.rawHeaders[i].toLowerCase()))headers.push(req.rawHeaders[i],req.rawHeaders[i+1]);
      headers.push("Host",target.host,"Connection","close");
      forward=http.request({hostname:"127.0.0.1",port:target.port,path,method,headers,agent:false},incoming=>{
        const response=[];let size=0;
        incoming.on("data",b=>{size+=b.length;if(size>65536){invalid=true;incoming.destroy();fail(res);return;}response.push(b);});
        incoming.on("error",()=>fail(res));
        incoming.on("end",()=>{
          const task=(async()=>{
          try{
            if(invalid||closing)return;
            const raw=Buffer.concat(response,size);
            if(kind==="lease"&&incoming.statusCode===200){const l=JSON.parse(raw.toString("utf8"));assert.match(l.credential,/^[a-f0-9]{64}$/);onSecret(l.credential);}
            if(kind==="metrics"){
              const id=req.headers["x-monitoring-batch-id"];
              assert.match(id,/^[a-f0-9]{32}$/);
              assert.equal(incoming.statusCode,200,"actual C DATA must confirm commit before loss injection");
              const receipt=JSON.parse(raw.toString("utf8"));
              assert.equal(receipt.state,"stored");assert.equal(receipt.id,id);
              assert.equal(receipt.sha,sha(body));assert.equal(receipt.bytes,body.length);
              assert.equal(receipt.durability,"same-tx-synchronous-commit");
              assert.ok(!captures.some(x=>x.id===id),"no repeated DATA, including same original lease");
              // Hook must query ACTUAL scratch PG receipt plus accepted rows and
              // verify commit. It may refuse, never supply replacement bytes.
              await onCommittedStored({id,bytes:Buffer.from(body),receipt}); verified++;
              if(invalid||closing)return;
              captures.push({id,bytes:Buffer.from(body),receipt});
              if(captures.length===2 && mode!=="happy"){finalId=id;dropped++;res.destroy();return;}
            }
            if(kind==="receipt" && mode==="withheld-final-evidence"){
              const input=JSON.parse(body.toString("utf8"));
              if(input.id===finalId){res.destroy();return;}
            }
            // Exact actual response bytes, status and raw headers. No synthetic C.
            res.writeHead(incoming.statusCode,incoming.rawHeaders);res.end(raw);
          }catch{fail(res);}
          })();
          pending.add(task);task.finally(()=>pending.delete(task));
        });
      });
      requests.add(forward);
      forward.once("close",()=>requests.delete(forward));
      forward.on("error",()=>fail(res));forward.end(body);
    });
  };
  const server=http.createServer(handler);
  server.maxConnections=4;server.requestTimeout=7000;server.headersTimeout=1000;server.keepAliveTimeout=1;
  server.on("connection",s=>{sockets.add(s);s.once("close",()=>sockets.delete(s));});
  return {
    server,
    // Captures include raw wire in MEMORY only, not safe to serialize to logs.
    captured:()=>captures.map(x=>({...x,bytes:Buffer.from(x.bytes)})),
    safeStatus:()=>({counts:{...counts},distinctDATA:captures.length,verifiedCommits:verified,droppedDATAResponses:dropped,refused,activeRequests:requests.size,activeSockets:sockets.size}),
    async close(){
      closing=true;
      const ended=[...requests,...sockets].map(x=>new Promise(r=>{x.once("close",r);x.destroy();}));
      await Promise.all(ended);await Promise.all([...pending]);
      if(server.listening)await new Promise(r=>server.close(r));
      assert.equal(requests.size,0);assert.equal(sockets.size,0);assert.equal(pending.size,0);
    },
  };
}
module.exports={createRealCProxy};
