import { setTimeout as sleep } from 'node:timers/promises';
export function trustedUrl(value:string):URL {
  const url=new URL(value);
  if(url.username||url.password||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('ENDPOINT_INVALID');
  return url;
}
export async function boundedBody(response:Response|Request,max=65536):Promise<Buffer> {
  const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('BODY_TOO_LARGE');chunks.push(value);}return Buffer.concat(chunks);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** No redirects, hidden retries, provider bodies, credentials or causes in exceptions. */
export async function providerJson(url:string,init:RequestInit,signal:AbortSignal,timeoutMs=5000):Promise<{status:number;data:unknown}> {
  trustedUrl(url);if(timeoutMs<1||timeoutMs>10000)throw Error('TIMEOUT_INVALID');
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);
  try {
    for(let attempt=0;;attempt++){
      const response=await fetch(url,{...init,redirect:'error',signal:deadline});const body=await boundedBody(response);
      if((init.method??'GET')==='GET'&&attempt===0&&[429,500,502,503,504].includes(response.status)){
        const seconds=Number(response.headers.get('retry-after')??'0');const delay=Math.min(1000,Math.max(100,Number.isFinite(seconds)?seconds*1000:100));
        await sleep(delay,undefined,{signal:deadline});continue;
      }
      return {status:response.status,data:response.status===204&&body.length===0?null:JSON.parse(body.toString())};
    }
  }catch{throw Error('PROVIDER_UNAVAILABLE');}
}
