'use strict';
// Synthetic fixture account exists only in the disposable local test database.
const fs=require('node:fs');const crypto=require('node:crypto');
(async()=>{
 const password=crypto.randomBytes(24).toString('hex');
 const r=await fetch('http://127.0.0.1:4730/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'acceptance@synthetic.invalid',password,orgName:'synthetic-acceptance',setupToken:process.env.MONITORING_SETUP_TOKEN})});
 if(r.status!==200)throw new Error('local fixture setup failed');
 const cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 for(const kind of ['api','app']){
   const k=await fetch('http://127.0.0.1:4730/api/ui/org/keys',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({kind,name:'synthetic acceptance'})});
   if(k.status!==200)throw new Error('local fixture key creation failed');
   const key=(await k.json()).key;if(!key)throw new Error('missing fixture key');
   console.log(`::add-mask::${key}`);
   fs.appendFileSync(process.env.GITHUB_ENV,`${kind.toUpperCase()}_KEY=${key}\n`);
 }
 console.log('Synthetic fixture initialized; keys masked; no account response retained.');
})().catch(e=>{console.error(e.message);process.exit(1);});
