import {afterEach,describe,expect,it,vi} from 'vitest';
import {createCostAwareRouter} from '../src/routing.js';
import type {Route} from '../../models/src/types.js';
const routes:Record<string,Route>={cheap:{provider:'openaiCompatible',endpoint:'http://127.0.0.1:1/v1',model:'small',pricing:{inputPerMillion:1,outputPerMillion:1}},strong:{provider:'openaiCompatible',endpoint:'http://127.0.0.1:1/v1',model:'large',pricing:{inputPerMillion:2,outputPerMillion:2}}};
const request={messages:[{role:'user' as const,content:'private question'}],maxTokens:32,seed:0};
const budget={maxCostUsd:1,maxAttempts:5,timeoutMs:3000,reservePerAttemptUsd:{cheap:0.1,strong:0.2}};
function response(usage=true){return new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'answer'},finish_reason:'stop'}],...(usage?{usage:{prompt_tokens:10,completion_tokens:5}}:{})})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
afterEach(()=>vi.unstubAllGlobals());
describe('cost-aware dispatch through models',()=>{
 it('returns cheap output when verifier passes at threshold',async()=>{
  const fetcher=vi.fn(async()=>response());vi.stubGlobal('fetch',fetcher);
  const router=createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8});
  const result=await router.run(request,{signal:new AbortController().signal,budget,verify:()=>({pass:true,confidence:0.8,source:'verifier'})});
  expect(fetcher).toHaveBeenCalledTimes(1);expect(result.selected).toBe('cheap');expect(result.knownCostUsd).toBe(0.000015);
 });
 it.each([{pass:false,confidence:1,source:'verifier' as const},{pass:true,confidence:0.5,source:'verifier' as const},{pass:true,confidence:null,source:'unavailable' as const}])('dispatches strong for %j',async verdict=>{
  const models:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{models.push(JSON.parse(init.body).model);return response();}));
  const result=await createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget,verify:()=>verdict});
  expect(models).toEqual(['small','large']);expect(result.selected).toBe('strong');expect(result.records).toHaveLength(2);expect(result.knownCostUsd).toBeCloseTo(0.000045);expect(result.decision).toEqual(verdict);
 });
 it('stops on unknown final billing and preserves subtotal',async()=>{
  const fetcher=vi.fn(async()=>response(false));vi.stubGlobal('fetch',fetcher);
  await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget,verify:()=>({pass:false,confidence:0,source:'verifier'})})).rejects.toMatchObject({reason:'unknown_cost',costStatus:'unknown',records:[{accounting:{attempts:[{costStatus:'unknown'}]}}]});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('denies an unaffordable first dispatch without a physical attempt',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget:{...budget,maxCostUsd:0.01},verify:()=>({pass:true,confidence:1,source:'verifier'})})).rejects.toMatchObject({reason:'budget',records:[],knownCostUsd:0});expect(fetcher).not.toHaveBeenCalled();
 });
 it('retains cheap billing when escalation reservation is denied',async()=>{
  const fetcher=vi.fn(async()=>response());vi.stubGlobal('fetch',fetcher);
  await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget:{...budget,maxCostUsd:0.15},verify:()=>({pass:false,confidence:0,source:'verifier'})})).rejects.toMatchObject({reason:'budget',knownCostUsd:0.000015,records:[{stage:'cheap'}]});expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('rejects invalid verifier confidence and does not claim model confidence',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response()));
  await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget,verify:()=>({pass:true,confidence:NaN,source:'verifier'})})).rejects.toMatchObject({reason:'verifier',records:[{stage:'cheap'}]});
 });
 it('preserves actual cost when a declared reservation is exceeded',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response()));
  await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget:{...budget,maxCostUsd:0.00001,reservePerAttemptUsd:{cheap:0.000001,strong:0.000001}},verify:()=>({pass:true,confidence:1,source:'verifier'})})).rejects.toMatchObject({reason:'budget',knownCostUsd:0.000015});
 });
 it('does not dispatch after caller cancellation',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const controller=new AbortController();controller.abort();
  await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:controller.signal,budget,verify:()=>({pass:true,confidence:1,source:'verifier'})})).rejects.toMatchObject({reason:'aborted',records:[]});expect(fetcher).not.toHaveBeenCalled();
 });
});

it('retains known failed retry costs without double-counting call usage',async()=>{
 let calls=0;vi.stubGlobal('fetch',vi.fn(async()=>{
  if(++calls===1)return new Response('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: {"error":"fixture"}\n\n',{headers:{'content-type':'text/event-stream'}});
  return response();
 }));
 const result=await createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget,verify:()=>({pass:true,confidence:1,source:'verifier'})});
 expect(calls).toBe(2);expect(result.records[0]!.accounting.attempts.map(a=>a.outcome)).toEqual(['failed','success']);expect(result.knownCostUsd).toBe(0.00003);
});
it('stops internal retries when the physical attempt limit is exhausted',async()=>{
 const fetcher=vi.fn(async()=>new Response('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: {"error":"fixture"}\n\n',{headers:{'content-type':'text/event-stream'}}));vi.stubGlobal('fetch',fetcher);
 await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget:{...budget,maxAttempts:1},verify:()=>({pass:true,confidence:1,source:'verifier'})})).rejects.toMatchObject({reason:'budget',knownCostUsd:0.000015,records:[{accounting:{attempts:[{attempt:1,outcome:'failed'}]}}]});expect(fetcher).toHaveBeenCalledTimes(1);
});
it('deadline interrupts a verifier that never settles, preserving incurred cheap cost',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>response()));
 await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget:{...budget,timeoutMs:20},verify:()=>new Promise(()=>{})})).rejects.toMatchObject({reason:'timeout',knownCostUsd:0.000015,records:[{stage:'cheap'}]});
});
it('deadline interrupts actual adapter wait and preserves unknown aborted billing',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>new Promise<Response>((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))));
 await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget:{...budget,timeoutMs:20},verify:()=>({pass:true,confidence:1,source:'verifier'})})).rejects.toMatchObject({reason:'timeout',costStatus:'unknown',records:[{accounting:{status:'aborted',attempts:[{outcome:'aborted',costStatus:'unknown'}]}}]});
});
it('unknown failed cheap attempt prevents provider retry and strong escalation',async()=>{
 const fetcher=vi.fn(async()=>new Response('unavailable',{status:503}));vi.stubGlobal('fetch',fetcher);
 await expect(createCostAwareRouter(routes,{cheap:'cheap',strong:'strong',minConfidence:0.8}).run(request,{signal:new AbortController().signal,budget,verify:()=>({pass:false,confidence:0,source:'verifier'})})).rejects.toMatchObject({reason:'unknown_cost',costStatus:'unknown',knownCostUsd:0,records:[{accounting:{attempts:[{attempt:1,costStatus:'unknown'}]}}]});expect(fetcher).toHaveBeenCalledTimes(1);
});
