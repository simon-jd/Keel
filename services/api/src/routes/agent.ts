import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { ChatChunk, ModelClient } from 'models/types';
import {validateLocalJudgeIdentity,validLocalJudgeRequest} from 'models/localJudgeProfile';

const call = z.object({id:z.string().min(1).max(256),name:z.string().min(1).max(128),args:z.unknown()}).strict();
const message = z.object({role:z.enum(['system','user','assistant','tool']),content:z.string().max(131072),toolCalls:z.array(call).max(64).optional(),toolCallId:z.string().min(1).max(256).optional()}).strict().refine(m=>m.role!=='tool'||!!m.toolCallId);
const input = z.object({model:z.literal('local').default('local'), messages:z.array(message).min(1).max(512), tools:z.array(z.object({name:z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/),description:z.string().max(16384).optional(),parameters:z.record(z.string(),z.unknown())}).strict()).max(128).default([]), seed:z.number().int().min(0).max(2147483647).default(0), temperature:z.number().min(0).max(2).default(0),maxTokens:z.number().int().positive().max(4096).default(2048),run_id:z.uuid().optional(),call_id:z.string().regex(/^[0-9a-f-]{36}:[0-9]{1,6}$/i).optional()}).strict();

/** Benchmark action generation only: upstream environments own execution/evaluation.
 * Tenant and route are operator configuration, never body parameters. Commercial routes
 * use separate trusted operator configuration and dispatch-bound prepaid admission.
 */
export function createAgentApp(options: {model:ModelClient; token:string; maxRequests:number; maxConcurrent?:number; timeoutMs?:number; benchmarkUnknownTools?:boolean; benchmarkIdentity?:{bindingHash:string;reservationId:string}}) {
  if (options.token.length<32 || !Number.isSafeInteger(options.maxRequests) || options.maxRequests<1 || options.maxRequests>200000) throw new Error('INVALID_API_CONFIGURATION');
  // In-flight dispatch bound. Default 1 (serial); concurrent episodes let local vLLM batch.
  const maxConcurrent=options.maxConcurrent??1;
  if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>64) throw new Error('INVALID_API_CONFIGURATION');
  const localJudgeProfile=options.model.localJudgeProfile===undefined?undefined:validateLocalJudgeIdentity(options.model.localJudgeProfile);
  if(localJudgeProfile&&(options.benchmarkIdentity||options.benchmarkUnknownTools))throw new Error('INCOMPATIBLE_LOCAL_JUDGE_API_CONFIGURATION');
  const app = new Hono(); let dispatched=0; let active=0;
  app.onError((_error,c)=>c.json({error:'INTERNAL_ERROR'},500));
  app.use('*', async (c,next)=>{
    const header=c.req.header('authorization') ?? '';
    const actual=Buffer.from(header); const wanted=Buffer.from(`Bearer ${options.token}`);
    if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted)) return c.json({error:'UNAUTHORIZED'},401);
    await next();
  });
  app.use('*',bodyLimit({maxSize:1_000_000,onError:c=>c.json({error:'BODY_LIMIT'},413)}));
  if(options.benchmarkIdentity)app.get('/v1/agent/identity',c=>c.json(options.benchmarkIdentity!));
  if(localJudgeProfile)app.get('/v1/agent/local-judge-profile',c=>c.json(localJudgeProfile));
  app.post('/v1/agent/step',async c=>{
    let raw:unknown; try {raw=await c.req.json();} catch{return c.json({error:'INVALID_INPUT'},400);}
    const parsed=input.safeParse(raw); if(!parsed.success)return c.json({error:'INVALID_INPUT'},400);
    const data=parsed.data;
    if(localJudgeProfile&&!validLocalJudgeRequest(data))return c.json({error:'LOCAL_JUDGE_INPUT_REJECTED'},400);
    if(Buffer.byteLength(JSON.stringify({messages:data.messages,tools:data.tools}))>131072)return c.json({error:'INPUT_LIMIT'},413);
    if(new Set(data.tools.map(t=>t.name)).size!==data.tools.length)return c.json({error:'INVALID_INPUT'},400);
    if(data.call_id && (!data.run_id||!data.call_id.startsWith(`${data.run_id}:`))) return c.json({error:'INVALID_INPUT'},400);
    if(active>=maxConcurrent||dispatched>=options.maxRequests)return c.json({error:'REQUEST_LIMIT'},429);
    // Claim before dispatch. Failures and cancellations consume the request; router has at most 5 attempts.
    active++;dispatched++;
    const run_id=data.run_id??randomUUID(); const call_id=data.call_id??`${run_id}:1`;
    const signal=AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(options.timeoutMs??150000)]);
    const start=performance.now();
    const metadata=()=>({call_id,run_id,latency_ms:performance.now()-start,prompt_hash:createHash('sha256').update(JSON.stringify({messages:data.messages,tools:data.tools})).digest('hex'),...(localJudgeProfile===undefined?{}:{localJudgeProfile})});
    try {
      let result:ChatChunk|undefined;
      for await(const chunk of options.model.stream({model:data.model,messages:data.messages.map(m=>({role:m.role,content:m.content,...(m.toolCalls?{toolCalls:m.toolCalls}:{}),...(m.toolCallId?{toolCallId:m.toolCallId}:{})})),tools:data.tools.map(t=>({name:t.name,parameters:t.parameters,...(t.description===undefined?{}:{description:t.description})})),seed:data.seed,temperature:data.temperature,maxTokens:data.maxTokens},{signal,run_id,call_id})) result=chunk;
      if(!result||result.invalidToolCalls?.some(t=>t.error==='malformed_json'||!options.benchmarkUnknownTools)) return c.json({error:'INVALID_MODEL_RESPONSE',accounting:result?.accounting??null,usage:result?.usage??null,invalidToolCalls:result?.invalidToolCalls??[],...metadata()},502);
      // Only this trusted action-only benchmark mode delegates unknown-name errors to the original environment.
      const calls=[...(result.toolCalls??[]),...(result.invalidToolCalls??[]).map(t=>({id:t.id,name:t.name,args:t.args}))];
      if(result.invalidToolCalls?.length && (!result.toolCallOrder || new Set(result.toolCallOrder).size!==calls.length || calls.some(t=>!result.toolCallOrder!.includes(t.id)))) return c.json({error:'INVALID_MODEL_RESPONSE',accounting:result.accounting??null,...metadata()},502);
      if(result.toolCallOrder)calls.sort((a,b)=>result!.toolCallOrder!.indexOf(a.id)-result!.toolCallOrder!.indexOf(b.id));
      return c.json({action:{role:'assistant',content:result.text??'',toolCalls:calls},invalidToolCalls:result.invalidToolCalls??[],accounting:result.accounting??null,usage:result.usage??null,...metadata()});
    }catch(error){
      const accounting=typeof error==='object'&&error!==null&&'accounting'in error ? error.accounting:null;
      const code=typeof error==='object'&&error!==null&&'code'in error ? error.code : undefined;
      const admission=options.benchmarkIdentity?(code==='budget_exhausted'?'BUDGET_EXHAUSTED':code==='budget_denied'?'BUDGET_DENIED':code==='invalid_request'?'MODEL_INPUT_REJECTED':undefined):undefined;
      return c.json({error:signal.aborted?'MODEL_TIMEOUT':admission??'MODEL_FAILED',accounting,...metadata()},502);
    }finally{active--;}
  });
  return app;
}
