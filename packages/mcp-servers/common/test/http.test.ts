import { expect,test } from 'vitest';
import { providerJson } from '../src/http.js';
import { fixture } from './helpers.js';
// A blind transport retry can duplicate a write; omitting bounded retry unnecessarily fails transient reads.
test('retries transient reads once but never repeats writes',async()=>{
 let gets=0;let posts=0;const provider=await fixture((req,res)=>{if(req.method==='GET'){gets++;res.statusCode=gets===1?503:200;}else{posts++;res.statusCode=503;}res.end('{}');});
 try{expect((await providerJson(provider.origin,{method:'GET'},new AbortController().signal,500)).status).toBe(200);expect(gets).toBe(2);expect((await providerJson(provider.origin,{method:'POST',body:'{}'},new AbortController().signal,500)).status).toBe(503);expect(posts).toBe(1);}finally{await provider.close();}
});
test('bounds slow and oversized bodies and does not follow credential redirects',async()=>{
 let targets=0;const provider=await fixture((req,res)=>{if(req.url==='/large'){res.end(JSON.stringify({private:'secret'.repeat(20000)}));}else if(req.url==='/redirect'){res.statusCode=302;res.setHeader('Location','/target');res.end('{}');}else if(req.url==='/target'){targets++;res.end('{}');}else{res.write('{');}});
 try{for(const path of ['/large','/redirect','/slow'])await expect(providerJson(provider.origin+path,{headers:{Authorization:'Bearer private-token'}},new AbortController().signal,50)).rejects.toThrow('PROVIDER_UNAVAILABLE');expect(targets).toBe(0);}finally{await provider.close();}
});
test('accepts documented empty 204 write response without retry',async()=>{
 let writes=0;const provider=await fixture((_req,res)=>{writes++;res.statusCode=204;res.end();});
 try{expect(await providerJson(provider.origin,{method:'PATCH',body:'{}'},new AbortController().signal)).toEqual({status:204,data:null});expect(writes).toBe(1);}finally{await provider.close();}
});
test('Retry-After wait is bounded and cancellable',async()=>{
 let reads=0;const provider=await fixture((_req,res)=>{reads++;res.statusCode=429;res.setHeader('Retry-After','999999');res.end('{}');});
 try{await expect(providerJson(provider.origin,{},AbortSignal.timeout(50),1000)).rejects.toThrow('PROVIDER_UNAVAILABLE');expect(reads).toBe(1);}finally{await provider.close();}
});
