import {sameLocalJudgeIdentity,validateLocalJudgeIdentity} from '../../models/src/localJudgeProfile.js';
import type {LocalJudgeIdentity} from '../../models/src/localJudgeProfile.js';

/** Authenticated, bounded metadata preflight only. It never requests inference. */
export async function verifyJudgeApiProfile(endpoint:string,token:string,fetcher:typeof fetch,expected?:LocalJudgeIdentity):Promise<void> {
 const url=new URL(endpoint);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password
  ||url.pathname!=='/v1/agent/step'||url.search||url.hash)throw new Error('TRUSTED_LOOPBACK_REQUIRED');
 if(typeof token!=='string'||token.length<32||/[\r\n]/.test(token))throw new Error('INVALID_TOKEN');
 url.pathname='/v1/agent/local-judge-profile';
 const checked=expected===undefined?undefined:validateLocalJudgeIdentity(expected);
 let response:Response;
 try {
  response=await fetcher(url.toString(),{
   method:'GET',redirect:'error',headers:{authorization:`Bearer ${token}`},
   signal:AbortSignal.timeout(10000),
  });
 }catch{throw new Error('LOCAL_JUDGE_PROFILE_PREFLIGHT_FAILED');}
 if(response.status===404&&checked===undefined) {
  await response.body?.cancel().catch(()=>undefined);
  return;
 }
 if(!response.ok) {
  await response.body?.cancel().catch(()=>undefined);
  throw new Error('LOCAL_JUDGE_PROFILE_PREFLIGHT_FAILED');
 }
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{reader=response.body?.getReader();}catch{throw new Error('LOCAL_JUDGE_PROFILE_PREFLIGHT_FAILED');}
 if(!reader)throw new Error('LOCAL_JUDGE_PROFILE_IDENTITY_MISMATCH');
 let bytes=0;
 const chunks:Uint8Array[]=[];
 try {
  while(true) {
   const next=await reader.read();
   if(next.done)break;
   bytes+=next.value.byteLength;
   if(bytes>16384)throw new Error();
   chunks.push(next.value);
  }
 }catch{throw new Error('LOCAL_JUDGE_PROFILE_PREFLIGHT_FAILED');}
 finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
 let value:unknown;
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
 catch{throw new Error('LOCAL_JUDGE_PROFILE_IDENTITY_MISMATCH');}
 if(checked===undefined||!sameLocalJudgeIdentity(value,checked))throw new Error('LOCAL_JUDGE_PROFILE_IDENTITY_MISMATCH');
}
