"use strict";
// Test-harness effect guard only. No production SDK imports this file.
const net=require("node:net");
function options(args){
 // Node createConnection passes [options, callback] as the sole connect arg.
 // Normalize only ordinary overloads, never normalize normalized arrays twice.
 const normalized=Array.isArray(args[0])?args[0]:net._normalizeArgs(args);
 return normalized[0];
}
function guard(origin,connect,notice=()=>{}){
 const allowed=new URL(origin),host=allowed.hostname.replace(/^\[|\]$/g,"");
 return function(...args){const opts=options(args);
  if(!opts||opts.path||String(opts.port)!==allowed.port||opts.host!==host||!["127.0.0.1","::1"].includes(opts.host)){
   notice(false);const e=Error("owned endpoint guard refused");e.code="OWNED_ENDPOINT_REFUSED";throw e;
  }
  notice(true);return connect.apply(this,args);
 };
}
module.exports={options,guard};
