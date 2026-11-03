import {afterEach,expect,test,vi} from 'vitest';
import {createAgentApp} from '../src/routes/agent.js';
import {createRouter} from 'models/router';
import {createLocalJudgeRoute,localJudgeIdentityFromEnvironment,LOCAL_JUDGE_PROFILE,LOCAL_JUDGE_RESPONSE_FORMAT} from 'models/localJudgeProfile';
import {createJudge,observeWithIntent,RUBRIC} from '../../../packages/evals/src/judge.js';
const token='a'.repeat(32),profile=localJudgeIdentityFromEnvironment({KEEL_LOCAL_JUDGE_PROFILE:LOCAL_JUDGE_PROFILE,KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'})!;
const body={model:'local',messages:[{role:'user',content:'fixture'}],temperature:0,seed:0,maxTokens:1024,tools:[]};
const request=(path:string,data?:unknown,auth=token)=>new Request(`http://127.0.0.1:18080${path}`,{headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})});
afterEach(()=>vi.unstubAllGlobals());
test('profile identity is authenticated and HTTP callers cannot choose schema, profile, provider or policy',async()=>{
 let calls=0;const app=createAgentApp({model:{localJudgeProfile:profile,async *stream(){calls++;yield {text:'{}'};}},token,maxRequests:1});
 expect((await app.fetch(request('/v1/agent/local-judge-profile',undefined,'bad'))).status).toBe(401);
 expect(await (await app.fetch(request('/v1/agent/local-judge-profile'))).json()).toEqual(profile);expect(calls).toBe(0);
 for(const bad of [{...body,profile:LOCAL_JUDGE_PROFILE},{...body,response_format:LOCAL_JUDGE_RESPONSE_FORMAT},{...body,provider:'openai'},{...body,endpoint:'https://external.invalid'},{...body,temperature:1},{...body,maxTokens:2048},{...body,seed:1},{...body,tools:[{name:'x',parameters:{}}]}])expect((await app.fetch(request('/v1/agent/step',bad))).status).toBe(400);
 expect(calls).toBe(0);expect((await app.fetch(request('/v1/agent/step',body))).status).toBe(200);expect(calls).toBe(1);
});
test('CPU fixture goes through verified authenticated API and trusted models native schema with full checkpoint attribution',async()=>{
 const provider=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  expect(JSON.parse(String(init?.body))).toMatchObject({response_format:LOCAL_JUDGE_RESPONSE_FORMAT,temperature:0,seed:0,max_tokens:1024,tools:[]});
  const event={choices:[{index:0,delta:{content:'{"label":"pass","rationale":"A"}'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}};
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 });vi.stubGlobal('fetch',provider);
 const app=createAgentApp({model:createRouter({local:createLocalJudgeRoute(profile)}),token,maxRequests:1});
 const judge=createJudge({token,localJudgeProfile:profile,fetch:async(url,init)=>app.fetch(new Request(String(url),init))});const events:unknown[]=[];
 const observation=await observeWithIntent(judge,{id:'CPU-fixture',input:{},action:{}},RUBRIC,event=>events.push(event));
 expect(observation).toMatchObject({localJudgeProfile:profile,verdict:{label:'pass'},accounting:{model:'keel-local',costStatus:'known',costUsd:0,attempts:[{attempt:1,usage:{input:2,output:3}}]}});
 expect(events).toMatchObject([{state:'dispatch-intent',intent:{localJudgeProfile:profile}},{state:'completed',observation:{localJudgeProfile:profile}}]);expect(provider).toHaveBeenCalledTimes(1);
});
test('explicit CLI profile commands reject missing trusted configuration before cohort or secret access',async()=>{
 const {main}=await import('../src/routes/label.js');
 for(const name of ['KEEL_LOCAL_JUDGE_PROFILE','KEEL_LOCAL_JUDGE_MODEL_SOURCE','KEEL_LOCAL_JUDGE_MODEL_REVISION','KEEL_LOCAL_JUDGE_RUNTIME_VERSION'])vi.stubEnv(name,undefined);
 try{for(const command of ['local-reproduce','local-judge','agent-local-reproduce','agent-local-judge'])await expect(main([command,'v1','/not-a-token','fresh-profile-fixture'])).rejects.toThrow('LOCAL_JUDGE_PROFILE_CONFIGURATION_REQUIRED');}
 finally{vi.unstubAllEnvs();}
});
test('malformed provider stream retains charged physical attempt and usage through API failure checkpoint',async()=>{
 const provider=vi.fn(async()=>new Response('data: {"choices":[],"usage":{"prompt_tokens":19,"completion_tokens":7}}\n\ndata: {broken\n\n',{headers:{'content-type':'text/event-stream'}}));vi.stubGlobal('fetch',provider);
 const app=createAgentApp({model:createRouter({local:createLocalJudgeRoute(profile)}),token,maxRequests:1});
 const judge=createJudge({token,localJudgeProfile:profile,fetch:async(url,init)=>app.fetch(new Request(String(url),init))});const events:unknown[]=[];
 await expect(observeWithIntent(judge,{id:'failed-CPU-fixture',input:{},action:{}},RUBRIC,event=>events.push(event))).rejects.toThrow('JUDGE_HTTP_STATUS_502');
 expect(events[1]).toMatchObject({state:'failed',failure:{evidence:{rawResponseHash:expect.stringMatching(/^[a-f0-9]{64}$/),accounting:{status:'failed',costStatus:'known',costUsd:0,attempts:[{attempt:1,outcome:'failed',costStatus:'known',costUsd:0,usage:{input:19,output:7}}]}}}});expect(provider).toHaveBeenCalledTimes(1);
});
test('v2 synthetic transport composes authenticated metadata, its own native wire, and the strict final parser',async()=>{
 const v2=localJudgeIdentityFromEnvironment({KEEL_LOCAL_JUDGE_PROFILE:'task9-local-json-schema-v2',KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'})!;
 const rationale='The selected tool and arguments satisfy the request.\nEvidence: "quoted" Unicode 支持 and C:\\path.';
 let content=JSON.stringify({label:'pass',rationale});
 // Transport fixtures do not run xgrammar or claim its acceptance of escaped strings.
 const provider=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const format=JSON.parse(String(init?.body)).response_format;
  expect(format.json_schema).toMatchObject({name:'keel_task9_verdict_v2',strict:true,schema:{properties:{rationale:{type:'string',minLength:1,maxLength:32768}}}});
  expect(format.json_schema.schema.properties.rationale).not.toHaveProperty('pattern');
  return new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 });vi.stubGlobal('fetch',provider);
 const app=createAgentApp({model:createRouter({local:createLocalJudgeRoute(v2)}),token,maxRequests:10});
 expect((await app.fetch(request('/v1/agent/local-judge-profile',undefined,'bad'))).status).toBe(401);
 expect(await (await app.fetch(request('/v1/agent/local-judge-profile'))).json()).toEqual(v2);
 for(const extra of [{profile:LOCAL_JUDGE_PROFILE},{schema:{}},{response_format:LOCAL_JUDGE_RESPONSE_FORMAT},{endpoint:'http://127.0.0.1:19000/v1'}])expect((await app.fetch(request('/v1/agent/step',{...body,...extra}))).status).toBe(400);
 expect(provider).not.toHaveBeenCalled();
 const judge=createJudge({token,localJudgeProfile:v2,fetch:async(url,init)=>app.fetch(new Request(String(url),init))});
 expect(await judge.observe({id:'v2-valid-fixture',input:{},action:{}},RUBRIC)).toMatchObject({localJudgeProfile:{...v2,liveEnforcement:'NOT_YET_PROVEN'},verdict:{label:'pass',rationale}});
 for(const bad of ['{"label":"pass","rationale":"   "}','{"label":"pass","rationale":"A\tB"}','{"label":"pass","rationale":"a","rationale":"b"}','{"label":"pass","rationale":"a","extra":true}','{"label":"pass","rationale":',JSON.stringify({label:'pass',rationale:'x'.repeat(32769)})]){
  content=bad;const events:unknown[]=[];
  await expect(observeWithIntent(judge,{id:'v2-invalid-fixture',input:{},action:{}},RUBRIC,event=>events.push(event))).rejects.toThrow(/INVALID_JUDGE/);
  expect(events[1]).toMatchObject({state:'failed',failure:{evidence:{intent:{localJudgeProfile:v2},usage:{input:2,output:3},accounting:{status:'success',costStatus:'known',costUsd:0,attempts:[{attempt:1,outcome:'success',usage:{input:2,output:3}}]}}}});
 }
 expect(provider).toHaveBeenCalledTimes(7);
});
test('CLI keeps legacy and historical v1 output names and gives v2 a separate explicit namespace',async()=>{
 const {judgeRunPrefix}=await import('../src/routes/label.js');
 const v2=localJudgeIdentityFromEnvironment({KEEL_LOCAL_JUDGE_PROFILE:'task9-local-json-schema-v2',KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'})!;
 expect(judgeRunPrefix(false)).toBe('');expect(judgeRunPrefix(true)).toBe('agent-');
 expect(judgeRunPrefix(false,profile)).toBe('local-json-schema-');expect(judgeRunPrefix(true,profile)).toBe('agent-local-json-schema-');
 expect(judgeRunPrefix(false,v2)).toBe('local-json-schema-v2-');expect(judgeRunPrefix(true,v2)).toBe('agent-local-json-schema-v2-');
});
