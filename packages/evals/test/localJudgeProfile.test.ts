import {expect,test,vi} from 'vitest';
import {createJudge,hash,JudgeFailure,observeWithIntent,parseVerdict,reproduce,RUBRIC,validLocalJudgeObservation} from '../src/judge.js';
import {verifyJudgeApiProfile} from '../src/localJudgeProtocol.js';
import {localJudgeIdentityFromEnvironment,LOCAL_JUDGE_PROFILE} from '../../models/src/localJudgeProfile.js';

const profile=localJudgeIdentityFromEnvironment({KEEL_LOCAL_JUDGE_PROFILE:LOCAL_JUDGE_PROFILE,KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'})!;
const token='x'.repeat(32),sample={id:'fixture',input:{},action:{}};
function response(init?:RequestInit,extra:Record<string,unknown>={},identity=profile){
 const request=JSON.parse(String(init?.body));const usage={input:2,output:3};
 const accounting={model:'keel-local',provider:'openaiCompatible',status:'success',costStatus:'known',costUsd:0,usage,run_id:request.run_id,call_id:request.call_id,attempts:[{attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage}]};
 return new Response(JSON.stringify({localJudgeProfile:identity,action:{role:'assistant',content:JSON.stringify({label:'pass',rationale:identity.profile===LOCAL_JUDGE_PROFILE?'A':'Supports the requested tool and arguments.'}),toolCalls:[]},invalidToolCalls:[],usage,accounting,run_id:request.run_id,call_id:request.call_id,...extra}));
}
test('requested local profile must be verified before any inference',async()=>{
 for(const preflight of [()=>new Response('{}'),()=>new Response('',{status:404}),()=>new Response('',{status:401}),()=>new Response(JSON.stringify({...profile,configured:{...profile.configured,modelRevision:'b'.repeat(40)}})),()=>new Response(JSON.stringify({...profile,providerObservedRevision:'invented'}))]){
  let inference=0;const fetcher=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{if(init?.method==='POST'){inference++;return response(init);}return preflight();});
  const judge=createJudge({token,fetch:fetcher,localJudgeProfile:profile});
  await expect(judge.observe(sample,RUBRIC)).rejects.toThrow(/LOCAL_JUDGE_PROFILE/);expect(inference).toBe(0);
 }
});
test('complete protocol attribution is bound to durable intent and every observation; preflight is authenticated and cached',async()=>{
 const events:unknown[]=[];
 const fetcher=vi.fn(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  expect(init?.headers).toMatchObject({authorization:`Bearer ${token}`});expect(init?.redirect).toBe('error');
  if(init?.method==='GET'){expect(String(url)).toBe('http://127.0.0.1:18080/v1/agent/local-judge-profile');expect(events).toHaveLength(0);return new Response(JSON.stringify(profile));}
  expect(events).toHaveLength(1);expect(String(init?.body)).not.toContain('localJudgeProfile');return response(init);
 });
 const judge=createJudge({token,fetch:fetcher,localJudgeProfile:profile});
 const observation=await observeWithIntent(judge,sample,RUBRIC,event=>{events.push(event);});
 expect(observation).toMatchObject({localJudgeProfile:profile,accounting:{model:'keel-local',provider:'openaiCompatible',run_id:observation.requestedRunId,call_id:observation.requestedCallId}});
 expect(events).toMatchObject([{state:'dispatch-intent',intent:{localJudgeProfile:profile}},{state:'completed',observation:{localJudgeProfile:profile}}]);
 await judge.verifyProfile();expect(fetcher.mock.calls.filter(([,init])=>init?.method==='GET')).toHaveLength(1);
});
test('profile failures keep known accounting, raw response hash, usage and protocol without relaxing parser',async()=>{
 for(const extra of [{action:{role:'assistant',content:'```json\n{"label":"pass","rationale":"A"}\n```',toolCalls:[]}},{localJudgeProfile:undefined},{run_id:'wrong'}]){
  let raw='';const fetcher=async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{if(init?.method==='GET')return new Response(JSON.stringify(profile));const r=response(init,extra);raw=await r.text();return new Response(raw);};
  const events:unknown[]=[];const judge=createJudge({token,fetch:fetcher,localJudgeProfile:profile});
  try{await observeWithIntent(judge,sample,RUBRIC,event=>events.push(event));throw new Error('expected failure');}
  catch(error){expect(error).toBeInstanceOf(JudgeFailure);expect((error as JudgeFailure).evidence).toMatchObject({intent:{localJudgeProfile:profile},rawResponseHash:hash(raw),usage:{input:2,output:3},accounting:{costStatus:'known',attempts:[{attempt:1,usage:{input:2,output:3}}]}});expect(events[1]).toMatchObject({state:'failed'});}
 }
});
test('profile preflight bounds reads and rejects unsafe URL before exposing credentials',async()=>{
 let cancelled=false;const fetcher=vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}})));
 await expect(verifyJudgeApiProfile('http://127.0.0.1:18080/v1/agent/step',token,fetcher,profile)).rejects.toThrow('PREFLIGHT_FAILED');expect(cancelled).toBe(true);
 fetcher.mockClear();await expect(verifyJudgeApiProfile('https://external.invalid/v1/agent/step',token,fetcher,profile)).rejects.toThrow('TRUSTED_LOOPBACK_REQUIRED');expect(fetcher).not.toHaveBeenCalled();
});
test('legacy CLI preflight accepts disabled endpoint and rejects an enabled profile before inference',async()=>{
 await expect(verifyJudgeApiProfile('http://127.0.0.1:18080/v1/agent/step',token,async()=>new Response('',{status:404}))).resolves.toBeUndefined();
 await expect(verifyJudgeApiProfile('http://127.0.0.1:18080/v1/agent/step',token,async()=>new Response(JSON.stringify(profile)))).rejects.toThrow('IDENTITY_MISMATCH');
 const legacy=createJudge({token,fetch:async(_url,init)=>response(init)});await expect(legacy.observe(sample,RUBRIC)).rejects.toThrow('UNEXPECTED_LOCAL_JUDGE_PROFILE');
});
test('fresh five-request reproduction under the profile includes exactly five new physical calls',async()=>{
 let inference=0;const judge=createJudge({token,localJudgeProfile:profile,fetch:async(_url,init)=>{if(init?.method==='GET')return new Response(JSON.stringify(profile));inference++;return response(init);}});
 const report=await reproduce(judge,sample,RUBRIC);expect(inference).toBe(5);expect(report.semanticEqual).toBe(true);expect(report.runs.every(r=>r.localJudgeProfile?.profile===LOCAL_JUDGE_PROFILE)).toBe(true);
});
test('unknown successful profile usage fails closed and retains full one-attempt evidence; legacy accounting stays strict',async()=>{
 const fetcher=async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  if(init?.method==='GET')return new Response(JSON.stringify(profile));
  const request=JSON.parse(String(init?.body));
  return response(init,{usage:null,accounting:{model:'keel-local',provider:'openaiCompatible',status:'success',costStatus:'unknown',costUsd:0,run_id:request.run_id,call_id:request.call_id,attempts:[{attempt:1,outcome:'success',costStatus:'unknown'}]}});
 };
 try{await createJudge({token,fetch:fetcher,localJudgeProfile:profile}).observe(sample,RUBRIC);throw new Error('expected failure');}
 catch(error){expect(error).toBeInstanceOf(JudgeFailure);expect(error).toMatchObject({code:'LOCAL_JUDGE_CALL_IDENTITY_MISMATCH',evidence:{usage:null,accounting:{costStatus:'unknown',usage:null,attempts:[{costStatus:'unknown',costUsd:null,usage:null}]}}});}
 const legacy=createJudge({token,fetch:async(_url,init)=>response(init,{localJudgeProfile:undefined,accounting:{model:'keel-local',provider:'openaiCompatible',status:'success',costStatus:'unknown',costUsd:0,attempts:[{attempt:1,outcome:'success',costStatus:'unknown',costUsd:null}]}})});
 await expect(legacy.observe(sample,RUBRIC)).rejects.toThrow('INVALID_ATTEMPT_ACCOUNTING');
});
test('successful local receipt requires identical known-zero observation, aggregate and sole physical attempt',()=>{
 const run='12345678-abcd-4000-a000-123456789012',call=`${run}:1`,usage={input:2,output:3};
 const attempt={attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage};
 const accounting={model:'keel-local',provider:'openaiCompatible',status:'success',costStatus:'known',costUsd:0,usage,run_id:run,call_id:call,attempts:[attempt]};
 const observation={localJudgeProfile:profile,requestedRunId:run,requestedCallId:call,runId:run,callId:call,usage,accounting};
 expect(validLocalJudgeObservation(observation,profile)).toBe(true);
 for(const changed of [{usage:{input:900,output:800}},{usage:undefined},{costStatus:'unknown'},{costUsd:undefined},{costUsd:null},{costUsd:0.1},{outcome:'failed'}])expect(validLocalJudgeObservation({...observation,accounting:{...accounting,attempts:[{...attempt,...changed}]}},profile)).toBe(false);
 for(const changed of [{costStatus:'unknown'},{usage:undefined},{costUsd:undefined},{status:'failed'}])expect(validLocalJudgeObservation({...observation,accounting:{...accounting,...changed}},profile)).toBe(false);
 expect(validLocalJudgeObservation({...observation,usage:null,accounting:{...accounting,costStatus:'unknown',usage:null,attempts:[{...attempt,costStatus:'unknown',costUsd:null,usage:null}]}},profile)).toBe(false);
 expect(validLocalJudgeObservation({...observation,usage:undefined},profile)).toBe(false);
});
test('strict final parser retains complete escaped and multiline rationale and rejects grammar-permitted bad strings',()=>{
 for(const rationale of ['Supports the requested tool and each required argument.','Line one\nLine two with "quotes" and C:\\path\\file','Unicode 支持 😀','x'.repeat(32768)])expect(parseVerdict(JSON.stringify({label:'pass',rationale}))).toEqual({label:'pass',rationale});
 expect(parseVerdict('{"label":"pass","rationale":"\\u0041\\ud83d\\ude00"}').rationale).toBe('A😀');
 for(const raw of [JSON.stringify({label:'pass',rationale:''}),JSON.stringify({label:'pass',rationale:' \t\n\u00a0'}),JSON.stringify({label:'pass',rationale:'x'.repeat(32769)}),'{"label":"pass","rationale":"x","extra":true}','{"label":"pass","rationale":"x","rationale":"y"}','{"label":"fail","label":"pass","rationale":"x"}','{"label":"pass","rationale":"unterminated}',...['\u0000','\t','\b','\f','\u001f','\n'].map(control=>`{"label":"pass","rationale":"A${control}B"}`)])expect(()=>parseVerdict(raw)).toThrow();
});
test('v2 preflight and every physical call reject v1 identity without losing accounted failure',async()=>{
 const v2=localJudgeIdentityFromEnvironment({KEEL_LOCAL_JUDGE_PROFILE:'task9-local-json-schema-v2',KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'})!;
 for(const [expected,actual] of [[profile,v2],[v2,profile]] as const){
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(actual)));
  await expect(createJudge({token,localJudgeProfile:expected,fetch:fetcher}).observe(sample,RUBRIC)).rejects.toThrow('IDENTITY_MISMATCH');expect(fetcher).toHaveBeenCalledTimes(1);
 }
 const judge=createJudge({token,localJudgeProfile:v2,fetch:async(_url,init)=>init?.method==='GET'?new Response(JSON.stringify(v2)):response(init)});
 await expect(judge.observe(sample,RUBRIC)).rejects.toMatchObject({code:'LOCAL_JUDGE_PROFILE_IDENTITY_MISMATCH',evidence:{usage:{input:2,output:3},accounting:{costStatus:'known',costUsd:0,attempts:[{attempt:1,usage:{input:2,output:3}}]}}});
 const valid=createJudge({token,localJudgeProfile:v2,fetch:async(_url,init)=>init?.method==='GET'?new Response(JSON.stringify(v2)):response(init,{},v2)});
 expect((await valid.observe(sample,RUBRIC)).localJudgeProfile).toEqual(v2);
});
