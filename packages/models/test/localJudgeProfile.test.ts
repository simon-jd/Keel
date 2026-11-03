import {afterEach,expect,test,vi} from 'vitest';
import {createRouter} from '../src/router.js';
import type {ChatRequest,Route} from '../src/types.js';
import {createLocalJudgeRoute,localJudgeIdentityFromEnvironment,LOCAL_JUDGE_PROFILE,LOCAL_JUDGE_RESPONSE_FORMAT,LOCAL_JUDGE_WIRE_POLICY,LOCAL_JUDGE_SCHEMA,sameLocalJudgeIdentity,validateLocalJudgeIdentity} from '../src/localJudgeProfile.js';

const responseFormat={type:'json_schema',json_schema:{name:'fixture_verdict',strict:true,schema:{type:'object',additionalProperties:false,required:['label'],properties:{label:{type:'string',enum:['pass','fail']}}}}};
const route={provider:'openaiCompatible',endpoint:'http://127.0.0.1:18000/v1',model:'keel-local',pricing:{inputPerMillion:0,outputPerMillion:0},responseFormat} as Route;
afterEach(()=>vi.unstubAllGlobals());
test('trusted route supplies native JSON schema; request cannot replace the configured schema',async()=>{
 const fetcher=vi.fn(async(_url:Parameters<typeof fetch>[0],_init?:RequestInit)=>sse());
 vi.stubGlobal('fetch',fetcher);
 const router=createRouter({local:route});
 for await(const _chunk of router.stream({...req,responseFormat:{type:'text'}} as ChatRequest,{signal:AbortSignal.timeout(1000)})){ /* final chunk */ }
 expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({response_format:responseFormat});
});
const environment={KEEL_LOCAL_JUDGE_PROFILE:LOCAL_JUDGE_PROFILE,KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'};
const identity=()=>localJudgeIdentityFromEnvironment(environment)!;
const req:ChatRequest={model:'local',messages:[{role:'system',content:'fixed rubric'},{role:'user',content:'fixture'}],tools:[],seed:0,temperature:0,maxTokens:1024};
function sse(tail='data: [DONE]\n\n'){return new Response(`data: {"choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n${tail}`,{headers:{'content-type':'text/event-stream'}});}
async function collect(route:Route,request=req){const out=[];for await(const c of createRouter({local:route}).stream(request,{signal:AbortSignal.timeout(1000),run_id:'fixture-run',call_id:'fixture-call'}))out.push(c);return out;}
test('explicit operator opt-in requires a pinned source revision and supported runtime',()=>{
 expect(localJudgeIdentityFromEnvironment({})).toBeUndefined();
 expect(identity()).toMatchObject({wirePolicySha256:'f9698e63f922a48a4b59c540268461bd9195b67cc74cabf5ebeddb2a159fac09',schemaSha256:'d50bf2a45960e43fa6e6be0ef4ae110493bbf459263578817aeb9524a027879b'});
 for(const selected of [LOCAL_JUDGE_PROFILE,'task9-local-json-schema-v2'])for(const changed of [{KEEL_LOCAL_JUDGE_PROFILE:undefined},{KEEL_LOCAL_JUDGE_PROFILE:'unknown'},{KEEL_LOCAL_JUDGE_PROFILE:'constructor'},{KEEL_LOCAL_JUDGE_MODEL_SOURCE:''},{KEEL_LOCAL_JUDGE_MODEL_REVISION:'main'},{KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'unknown'}])expect(()=>localJudgeIdentityFromEnvironment({...environment,KEEL_LOCAL_JUDGE_PROFILE:selected,...changed})).toThrow();
});
test('v2 explicitly selects its own bounded no-pattern wire while historical v1 stays reconstructible',async()=>{
 const original=identity(),v2=localJudgeIdentityFromEnvironment({...environment,KEEL_LOCAL_JUDGE_PROFILE:'task9-local-json-schema-v2'})!;
 expect(original).toEqual({profile:'task9-local-json-schema-v1',protocol:'openai-chat-completions-sse-json-schema-v1',wirePolicySha256:'f9698e63f922a48a4b59c540268461bd9195b67cc74cabf5ebeddb2a159fac09',schemaSha256:'d50bf2a45960e43fa6e6be0ef4ae110493bbf459263578817aeb9524a027879b',configured:{attribution:'operator-configured',modelSource:'fixture/model',modelRevision:'a'.repeat(40),servedModel:'keel-local',runtime:{name:'vllm',version:'0.17.1'}},liveEnforcement:'NOT_YET_PROVEN'});
 expect(LOCAL_JUDGE_SCHEMA.properties.rationale).toEqual({type:'string',minLength:1,maxLength:32768,pattern:'\\S'});
 expect(validateLocalJudgeIdentity(JSON.parse(JSON.stringify(original)))).toEqual(original);
 expect(v2).toEqual({...original,profile:'task9-local-json-schema-v2',protocol:'openai-chat-completions-sse-json-schema-v2',schemaSha256:'8555d7a223d87b528cdb74e2a259d725a40780fef2b3e722ea45a68f8e2e3c4d',wirePolicySha256:'b898e61bc1b8513b74c36245bcf0b595aad2a2ee67d87bbfc8380d1e4b86c988'});
 expect(sameLocalJudgeIdentity(original,v2)).toBe(false);
 for(const changed of [{profile:original.profile},{protocol:original.protocol},{schemaSha256:original.schemaSha256},{wirePolicySha256:original.wirePolicySha256},{liveEnforcement:'PROVEN'},{extra:true}])expect(()=>validateLocalJudgeIdentity({...v2,...changed})).toThrow('IDENTITY_MISMATCH');
 const routeV2=createLocalJudgeRoute(v2),fetcher=vi.fn(async(_url:Parameters<typeof fetch>[0],_init?:RequestInit)=>sse());vi.stubGlobal('fetch',fetcher);
 await collect(routeV2);
 const wire=JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
 expect(wire).toEqual({model:'keel-local',messages:req.messages,stream:true,stream_options:{include_usage:true},temperature:0,seed:0,max_tokens:1024,tools:[],response_format:{type:'json_schema',json_schema:{name:'keel_task9_verdict_v2',strict:true,schema:{...LOCAL_JUDGE_SCHEMA,properties:{label:LOCAL_JUDGE_SCHEMA.properties.label,rationale:{type:'string',minLength:1,maxLength:32768}}}}}});
 for(const mixed of [{...routeV2,responseFormat:LOCAL_JUDGE_RESPONSE_FORMAT},{...createLocalJudgeRoute(original),responseFormat:routeV2.responseFormat!}])expect(()=>createRouter({local:mixed})).toThrow('INVALID_LOCAL_JUDGE_ROUTE');
});
test('fixed profile pins native wire, zero local cost, and operator attribution without provider claims',async()=>{
 const fetcher=vi.fn(async(_url:Parameters<typeof fetch>[0],_init?:RequestInit)=>sse());vi.stubGlobal('fetch',fetcher);
 const model=createRouter({local:createLocalJudgeRoute(identity(),'private-fixture-token')});
 expect(model.localJudgeProfile).toMatchObject({profile:LOCAL_JUDGE_PROFILE,wirePolicySha256:expect.stringMatching(/^[a-f0-9]{64}$/),schemaSha256:expect.stringMatching(/^[a-f0-9]{64}$/),configured:{attribution:'operator-configured',modelSource:'fixture/model',modelRevision:'a'.repeat(40),servedModel:'keel-local',runtime:{name:'vllm',version:'0.17.1'}},liveEnforcement:'NOT_YET_PROVEN'});
 let result;for await(const chunk of model.stream(req,{signal:AbortSignal.timeout(1000)}))result=chunk;
 const [url,init]=fetcher.mock.calls[0]!;expect(url).toBe(`${LOCAL_JUDGE_WIRE_POLICY.endpoint}/chat/completions`);expect(init?.redirect).toBe('error');
 expect(JSON.parse(String(init?.body))).toEqual({model:'keel-local',messages:req.messages,stream:true,stream_options:{include_usage:true},temperature:0,seed:0,max_tokens:1024,tools:[],response_format:LOCAL_JUDGE_RESPONSE_FORMAT});
 expect(result?.accounting).toMatchObject({costStatus:'known',costUsd:0,attempts:[{attempt:1,costStatus:'known',usage:{input:2,output:3}}]});expect(JSON.stringify(model.localJudgeProfile)).not.toContain('private-fixture-token');
});
test('fixed profile rejects forged bindings, route drift and request policy drift before fetch',async()=>{
 const fetcher=vi.fn(async()=>sse());vi.stubGlobal('fetch',fetcher);const route=createLocalJudgeRoute(identity());
 for(const changed of [{localJudge:{}},{provider:'openai' as const},{endpoint:'https://external.invalid/v1'},{model:'different'},{pricing:{inputPerMillion:1,outputPerMillion:0}},{responseFormat:undefined}])expect(()=>createRouter({local:{...route,...changed} as Route})).toThrow();
 expect(()=>createRouter({other:route})).toThrow();
 for(const changed of [{temperature:1},{seed:1},{maxTokens:2048},{tools:[{name:'tool',parameters:{}}]},{messages:[{role:'assistant' as const,content:'output'}]}])await expect(collect(route,{...req,...changed})).rejects.toMatchObject({code:'invalid_request'});
 expect(fetcher).not.toHaveBeenCalled();
});
test('profile failures preserve known or unknown physical accounting and never retry',async()=>{
 for(const [response,known] of [[()=>sse(''),true],[()=>new Response('private failure',{status:503}),false],[()=>sse(`data: ${'x'.repeat(1_000_001)}\n\n`),false]] as const){
  const fetcher=vi.fn(async()=>response());vi.stubGlobal('fetch',fetcher);
  await expect(collect(createLocalJudgeRoute(identity()))).rejects.toMatchObject({accounting:{run_id:'fixture-run',call_id:'fixture-call',costStatus:known?'known':'unknown',attempts:[{attempt:1,outcome:'failed'}]}});
  expect(fetcher).toHaveBeenCalledTimes(1);
 }
});
test('JSON schema capability rejects unsupported provider before dispatch',()=>{
 expect(()=>createRouter({local:{...route,provider:'anthropic'}})).toThrow();
});
