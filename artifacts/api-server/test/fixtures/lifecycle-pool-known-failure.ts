// Retained KNOWN-FAILURE probe of f1616b1 lifecycle, not a passing product test.
import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {bootstrapExpiryStudy,issueExpiryLease,acceptExpiryLease} from '../../src/lib/expiryProtocolStudy';
import {bootstrapLifecycleStudy,enqueueLifecycleStudy,deliverLifecycleStudy} from '../../src/lib/expiryLifecycleStudy';
process.env.MONITORING_EXPIRY_PROTOCOL_TEST_ONLY='yes';process.env.MONITORING_EXPIRY_TEST_SECRET='synthetic-isolated-expiry-study-secret';
await bootstrapExpiryStudy();await bootstrapLifecycleStudy();const body=Buffer.from('7'),sha=createHash('sha256').update(body).digest('hex');const leases=[];for(let i=0;i<5;i++){const l=await issueExpiryLease(1,sha);await enqueueLifecycleStudy(l.token,1,body);leases.push(l);}
let release!:()=>void,entered!:()=>void;const barrier=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);
let completed=0;const first=deliverLifecycleStudy(1,leases[0].lease.id,async(t)=>{entered();await barrier;await acceptExpiryLease(t,1,sha,async c=>{await c.query('select 1');});}).then(()=>completed++);
await inside;const rest=leases.slice(1).map(l=>deliverLifecycleStudy(1,l.lease.id,async t=>{await acceptExpiryLease(t,1,sha,async c=>{await c.query('select 1');});}).then(()=>completed++));
await new Promise(r=>setTimeout(r,150));release();await Promise.race([Promise.all([first,...rest]),new Promise(r=>setTimeout(r,2000))]);
console.log(JSON.stringify({poolMax:pool.options.max,concurrent:5,completed,waitingClients:pool.waitingCount,knownFailure:completed!==5}));
// Deliberately stuck transactions cannot be safely drained. Child exit tears down
// only this scratch worker's sockets; PG rolls back, no external process killed.
process.exit(completed===5?0:3);
