/** Trusted operator configuration only. No HTTP request selects this profile or schema. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {JsonSchemaResponseFormat,Route} from './types.js';

function frozen<T>(value:T):T {
 if(value&&typeof value==='object') {
  for(const child of Object.values(value))frozen(child);
  Object.freeze(value);
 }
 return value;
}
const sha256=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Historical v1 exports remain pinned for stored evidence; opt in to v2 by its explicit name. */
export const LOCAL_JUDGE_PROFILE='task9-local-json-schema-v1';
export const LOCAL_JUDGE_SCHEMA=frozen({
 type:'object',
 properties:{
  label:{type:'string',enum:['pass','fail']},
  rationale:{type:'string',minLength:1,maxLength:32768,pattern:'\\S'},
 },
 required:['label','rationale'],
 additionalProperties:false,
});
export const LOCAL_JUDGE_RESPONSE_FORMAT:JsonSchemaResponseFormat=frozen({
 type:'json_schema',
 json_schema:{name:'keel_task9_verdict_v1',strict:true,schema:LOCAL_JUDGE_SCHEMA},
});
/** Hash encoding is JSON.stringify of these pinned, ordered, UTF-8 objects. */
export const LOCAL_JUDGE_WIRE_POLICY=frozen({
 version:LOCAL_JUDGE_PROFILE,
 protocol:'openai-chat-completions-sse-json-schema-v1',
 provider:'openaiCompatible',
 endpoint:'http://127.0.0.1:18000/v1',
 model:'keel-local',
 stream:true,
 stream_options:{include_usage:true},
 temperature:0,
 seed:0,
 max_tokens:1024,
 tools:[],
 response_format:LOCAL_JUDGE_RESPONSE_FORMAT,
 retries:0,
 responseByteLimit:1_000_000,
 redirect:'error',
});
export const LOCAL_JUDGE_PROFILE_V2='task9-local-json-schema-v2';
/** Generation aid only: the unchanged strict final parseVerdict remains authoritative.
 * Installed xgrammar 0.1.29 treats v1's pattern as exactly one character. Removing it
 * permits ordinary phrases, but still rejects some legal escaped strings, accepts
 * whitespace-only strings and some invalid raw controls. Native length 32768/32769
 * passed the diagnostic's tested cases only; the final JS-length bound stays authoritative.
 * Strict parsing catches overacceptance but cannot fix native rejection of legal escapes.
 * Parser rejection retains accounted failure with no retry. Live quality is unproven.
 */
export const LOCAL_JUDGE_SCHEMA_V2=frozen({
 type:'object',
 properties:{
  label:{type:'string',enum:['pass','fail']},
  rationale:{type:'string',minLength:1,maxLength:32768},
 },
 required:['label','rationale'],
 additionalProperties:false,
});
export const LOCAL_JUDGE_RESPONSE_FORMAT_V2:JsonSchemaResponseFormat=frozen({
 type:'json_schema',
 json_schema:{name:'keel_task9_verdict_v2',strict:true,schema:LOCAL_JUDGE_SCHEMA_V2},
});
export const LOCAL_JUDGE_WIRE_POLICY_V2=frozen({
 ...LOCAL_JUDGE_WIRE_POLICY,
 version:LOCAL_JUDGE_PROFILE_V2,
 protocol:'openai-chat-completions-sse-json-schema-v2',
 response_format:LOCAL_JUDGE_RESPONSE_FORMAT_V2,
});
const profiles={
 [LOCAL_JUDGE_PROFILE]:{schema:LOCAL_JUDGE_SCHEMA,responseFormat:LOCAL_JUDGE_RESPONSE_FORMAT,wirePolicy:LOCAL_JUDGE_WIRE_POLICY},
 [LOCAL_JUDGE_PROFILE_V2]:{schema:LOCAL_JUDGE_SCHEMA_V2,responseFormat:LOCAL_JUDGE_RESPONSE_FORMAT_V2,wirePolicy:LOCAL_JUDGE_WIRE_POLICY_V2},
};
function definition(selected:unknown){
 if(typeof selected!=='string'||!Object.hasOwn(profiles,selected))throw new Error('UNKNOWN_LOCAL_JUDGE_PROFILE');
 return profiles[selected as keyof typeof profiles];
}
export type LocalJudgeConfiguration={modelSource:string;modelRevision:string;runtimeVersion:string};
function buildIdentity(config:LocalJudgeConfiguration,selected:unknown) {
 const {schema,wirePolicy}=definition(selected);
 if(!config||typeof config.modelSource!=='string'
  ||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.modelSource)
  ||typeof config.modelRevision!=='string'||!/^[0-9a-f]{40}$/.test(config.modelRevision)
  ||config.runtimeVersion!=='0.17.1')throw new Error('INVALID_LOCAL_JUDGE_CONFIGURATION');
 return frozen({
  profile:wirePolicy.version,
  protocol:wirePolicy.protocol,
  wirePolicySha256:sha256(wirePolicy),
  schemaSha256:sha256(schema),
  configured:{
   attribution:'operator-configured' as const,
   modelSource:config.modelSource,
   modelRevision:config.modelRevision,
   servedModel:wirePolicy.model,
   runtime:{name:'vllm' as const,version:config.runtimeVersion},
  },
  liveEnforcement:'NOT_YET_PROVEN' as const,
 });
}
export type LocalJudgeIdentity=ReturnType<typeof buildIdentity>;
/** Reconstruct and compare the entire allowlisted identity, rejecting extra or missing fields. */
export function validateLocalJudgeIdentity(value:unknown):LocalJudgeIdentity {
 try {
  const v=value as LocalJudgeIdentity;
  const expected=buildIdentity({
   modelSource:v.configured.modelSource,
   modelRevision:v.configured.modelRevision,
   runtimeVersion:v.configured.runtime.version,
  },v.profile);
  if(!isDeepStrictEqual(value,expected))throw new Error();
  return expected;
 }catch{throw new Error('LOCAL_JUDGE_PROFILE_IDENTITY_MISMATCH');}
}
export function sameLocalJudgeIdentity(a:unknown,b:unknown):boolean {
 try{return isDeepStrictEqual(validateLocalJudgeIdentity(a),validateLocalJudgeIdentity(b));}
 catch{return false;}
}
export function localJudgeIdentityFromEnvironment(env:Record<string,string|undefined>):LocalJudgeIdentity|undefined {
 const selected=env.KEEL_LOCAL_JUDGE_PROFILE;
 if(selected===undefined) {
  const configured=['KEEL_LOCAL_JUDGE_MODEL_SOURCE','KEEL_LOCAL_JUDGE_MODEL_REVISION','KEEL_LOCAL_JUDGE_RUNTIME_VERSION'];
  if(configured.some(key=>env[key]!==undefined))throw new Error('LOCAL_JUDGE_PROFILE_OPT_IN_REQUIRED');
  return undefined;
 }
 return buildIdentity({
  modelSource:env.KEEL_LOCAL_JUDGE_MODEL_SOURCE??'',
  modelRevision:env.KEEL_LOCAL_JUDGE_MODEL_REVISION??'',
  runtimeVersion:env.KEEL_LOCAL_JUDGE_RUNTIME_VERSION??'',
 },selected);
}
const bindings=new WeakMap<object,LocalJudgeIdentity>();
export function createLocalJudgeRoute(identity:LocalJudgeIdentity,apiKey?:string):Route {
 const checked=validateLocalJudgeIdentity(identity),localJudge={};
 const {responseFormat,wirePolicy}=definition(checked.profile);
 bindings.set(localJudge,checked);
 return {
  provider:'openaiCompatible',endpoint:wirePolicy.endpoint,
  model:checked.configured.servedModel,pricing:{inputPerMillion:0,outputPerMillion:0},
  responseFormat,localJudge,
  ...(apiKey===undefined?{}:{apiKey}),
 };
}
export function localJudgeIdentityForRoute(route:Route,alias?:string):LocalJudgeIdentity|undefined {
 if(route.localJudge===undefined)return undefined;
 const identity=bindings.get(route.localJudge);
 if(!identity)throw new Error('INVALID_LOCAL_JUDGE_ROUTE');
 const {responseFormat,wirePolicy}=definition(identity.profile);
 if((alias!==undefined&&alias!=='local')
  ||route.provider!=='openaiCompatible'||route.endpoint!==wirePolicy.endpoint
  ||route.model!==identity.configured.servedModel||route.commercial!==undefined
  ||route.pricing?.inputPerMillion!==0||route.pricing?.outputPerMillion!==0
  ||!isDeepStrictEqual(route.responseFormat,responseFormat))throw new Error('INVALID_LOCAL_JUDGE_ROUTE');
 return identity;
}
export function isLocalJudgeRoute(route:Route):boolean {
 return localJudgeIdentityForRoute(route)!==undefined;
}
export function validLocalJudgeRequest(req:{
 model:string;temperature?:unknown;seed?:unknown;maxTokens?:unknown;tools?:unknown;
 messages:{role:string;toolCalls?:unknown;toolCallId?:unknown}[];
}):boolean {
 return req.model==='local'&&req.temperature===0&&req.seed===0&&req.maxTokens===1024
  &&Array.isArray(req.tools)&&req.tools.length===0
  &&req.messages.every(m=>['system','user'].includes(m.role)&&m.toolCalls===undefined&&m.toolCallId===undefined);
}
