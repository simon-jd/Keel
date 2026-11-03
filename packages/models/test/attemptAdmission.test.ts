import {afterEach,expect,it,vi} from 'vitest';
import {createRouter} from '../src/router.js';
import type {AttemptAdmission} from '../src/types.js';
const route={provider:'openaiCompatible' as const,endpoint:'http://127.0.0.1:1/v1',model:'fixture',apiKey:'must-never-reach-hook',pricing:{inputPerMillion:1,outputPerMillion:1}};
const req={model:'local',messages:[{role:'user' as const,content:'private'}]};
async function collect<T>(stream:AsyncIterable<T>){const values:T[]=[];for await(const value of stream)values.push(value);return values;}
const opts=()=>({signal:new AbortController().signal,run_id:'run',call_id:'call'});
const usageFailure=()=>new Response('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: {"error":"fixture"}\n\n',{headers:{'content-type':'text/event-stream'}});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('hook denial makes no fetch and no fictitious physical attempt',async()=>{
 const fetcher=vi.fn(async()=>new Response('bad',{status:400}));vi.stubGlobal('fetch',fetcher);
 const router=createRouter({local:route},{beforeAttempt:async()=>{throw new Error('private');}});
 await expect(collect(router.stream(req,opts()))).rejects.toMatchObject({code:'budget_denied',accounting:{attempts:[],costStatus:'known',costUsd:0}});expect(fetcher).not.toHaveBeenCalled();
});
it('unknown first physical attempt blocks retry and retains unknown accounting',async()=>{
 const fetcher=vi.fn(async()=>new Response('bad',{status:503}));vi.stubGlobal('fetch',fetcher);
 const seen:AttemptAdmission[]=[];
 const router=createRouter({local:route},{beforeAttempt:async info=>{seen.push(info);if(info.priorAttempts.some(a=>a.costStatus==='unknown'))throw new Error('stop');}});
 await expect(collect(router.stream(req,opts()))).rejects.toMatchObject({code:'budget_denied',accounting:{costStatus:'unknown',attempts:[{attempt:1,costStatus:'unknown'}]}});
 expect(fetcher).toHaveBeenCalledTimes(1);expect(seen[0]).toEqual({alias:'local',model:'fixture',provider:'openaiCompatible',attempt:1,priorAttempts:[],run_id:'run',call_id:'call'});
});
it('async hook cancellation preserves prior billed attempts and stops dispatch',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>usageFailure()));const controller=new AbortController();
 const router=createRouter({local:route},{beforeAttempt:async info=>{await Promise.resolve();if(info.attempt===2)controller.abort();}});
 await expect(collect(router.stream(req,{...opts(),signal:controller.signal}))).rejects.toMatchObject({code:'aborted',accounting:{status:'aborted',costUsd:0.000015,costStatus:'known',attempts:[{attempt:1,outcome:'failed',costStatus:'known'}]}});
 expect(fetch).toHaveBeenCalledTimes(1);
});
it('hook sees clones and cannot corrupt retained prior billing',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>usageFailure()));
 const router=createRouter({local:route},{beforeAttempt:async info=>{if(info.attempt===2){info.priorAttempts[0]!.costUsd=100;throw new Error('denied');}}});
 await expect(collect(router.stream(req,opts()))).rejects.toMatchObject({code:'budget_denied',accounting:{costUsd:0.000015,attempts:[{costUsd:0.000015}]}});
});
