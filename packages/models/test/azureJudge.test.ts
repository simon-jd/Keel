import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {canonical,hash} from '../../evals/src/judge.js';
import policy from '../src/task9-judge-policy.json' with {type:'json'};
const pacing=vi.hoisted(()=>({starts:0}));
vi.mock('../src/judgePacing.js',()=>({createJudgePacer:()=>{let n=0;return async<T>(start:(timing:{startedAtMonotonicMs:number;intervalMs:number|null})=>Promise<T>)=>{pacing.starts++;return start({startedAtMonotonicMs:n*4000,intervalMs:n++?4000:null});};}}));
vi.mock('../src/judgeIdentity.js',()=>({judgeIdentity:()=>({gitSha:'b'.repeat(40),implementationSha256:'c'.repeat(64)})}));
vi.mock('../../evals/src/task9Source.js',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../evals/src/task9Source.js')>();
 const primary=Array.from({length:300},(_,i)=>({id:`synthetic-${i}`,input:{ask:i},action:{answer:i}}));
 return {...actual,loadCohort:()=>({primary,secondary:primary.slice(0,100),metadata:{cohortHash:policy.cohortHash,primaryIds:primary.map(s=>s.id)}}),readAgentReference:()=>({auditHash:'a'.repeat(64),summary:{sourceHashes:policy.referenceSourceHashes}})};
});
import {azureJudgeBody,prepareJudgeProfile} from '../src/azureJudgeProfile.js';
import {createAzureJudgeRoute} from '../src/azureCommercial.js';
import {createRouter} from '../src/router.js';
import type {ChatRequest,ModelClient} from '../src/types.js';
const root=new URL('../../../',import.meta.url).pathname;
const temp=mkdtempSync(join(tmpdir(),'keel-judge-commercial-'));
mkdirSync(join(root,'.secrets'),{recursive:true,mode:0o700});
const keys=mkdtempSync(join(root,'.secrets/synthetic-task9-'));
let sequence=0,dispatches=0;
function fixture(){
 const dir=join(temp,String(++sequence));mkdirSync(dir);const ledger=join(dir,'ledger.json'),keyFile=join(keys,String(sequence));
 writeFileSync(keyFile,'synthetic-private-key',{mode:0o600});
 writeFileSync(ledger,JSON.stringify({schema_version:1,project:'keel',currency:'USD',project_limit_usd:'10',gate_usd:'9',reservations:[]}));
 const quoteId=`synthetic-quote-${sequence}`;
 const quote={kind:'commercial_api',provider:'azure',currency:'USD',unit:'token',source:'https://prices.azure.com/api/retail/prices',quoted_at:new Date(Date.now()-1000).toISOString(),valid_until:new Date(Date.now()+3600000).toISOString(),model:policy.model,version:policy.version,region:policy.region,sku:policy.sku,quote_id:quoteId,input_usd_per_unit:'0.0000004',output_usd_per_unit:'0.0000016'};
 const profile=prepareJudgeProfile(quoteId,hash(canonical(quote))),binding=profile.binding;
 const result=spawnSync('python3',['-c','import sys,json;sys.path.insert(0,sys.argv[1]);import judge_budget;d=json.load(sys.stdin);print(json.dumps(judge_budget.reserve(d["ledger"],d["quote"],d["binding"])))',join(root,'scripts')],{input:JSON.stringify({ledger,quote,binding}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 if(result.status!==0)throw new Error(result.stderr);
 return {profile,config:{ledger,keyFile,reservationId:JSON.parse(result.stdout).reservation_id as string,binding,inputPerMillion:'0.4',outputPerMillion:'1.6'}};
}
function sse(text=JSON.stringify({label:'fail',rationale:'Synthetic adverse verdict'}),usage:unknown={prompt_tokens:2,completion_tokens:1}){
 return `data: ${JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:'stop'}],...(usage===undefined?{}:{usage})})}\n\ndata: [DONE]\n\n`;
}
function respond(raw=sse()){
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{dispatches++;expect(url).toBe(`${policy.endpoint}/chat/completions`);expect(init.redirect).toBe('error');expect((init.headers as Record<string,string>)['api-key']).toBe('synthetic-private-key');return new Response(raw,{headers:{'content-type':'text/event-stream'}});});
}
async function collect(client:ModelClient,request:ChatRequest,logical=0){const values=[];for await(const chunk of client.stream(request,{signal:AbortSignal.timeout(5000),commercialLogical:logical}))values.push(chunk);return values[0]!;}
function item(ledger:string){return JSON.parse(readFileSync(ledger,'utf8')).reservations[0];}
afterEach(()=>{vi.unstubAllGlobals();dispatches=0;pacing.starts=0;});
afterAll(()=>{rmSync(keys,{recursive:true,force:true});rmSync(temp,{recursive:true,force:true});});
it('exact shared wire, source prompt profile and byte limit reject arbitrary fields before consumption',async()=>{
 const f=fixture(),request=f.profile.requests[0]!,body=azureJudgeBody(request);respond();
 expect(body).toMatchObject({model:policy.deployment,n:1,max_completion_tokens:1024,seed:0,temperature:0,response_format:policy.wire.response_format});expect(hash(JSON.stringify(body))).toBe(f.profile.binding.jobs[0]!.requestHash);
 const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 for(const mutation of [{tools:[]},{maxTokens:1025},{temperature:1},{messages:[request.messages[0],{role:'user',content:'x'.repeat(4000)}]},{messages:[{role:'system',content:'changed'},request.messages[1]]}])await expect(collect(client,{...request,...mutation} as ChatRequest)).rejects.toMatchObject({code:'invalid_request'});
 expect(dispatches).toBe(0);expect(item(f.config.ledger).attempts).toHaveLength(0);
 const result=await collect(client,request);expect(result.accounting).toMatchObject({provider:'azureCommercial',model:policy.deployment,costStatus:'known'});expect(result.providerResponse?.raw).toBe(sse());
 expect(item(f.config.ledger)).toMatchObject({next_logical:1,known_cost_usd:'0.0000024',cost_status:'known'});
 expect(JSON.stringify(item(f.config.ledger))).not.toContain('synthetic-private-key');
});
it('cannot alias Azure as local or change phase source provider deployment version quote or ordered identity',async()=>{
 const f=fixture();respond();
 for(const patch of [{referenceAuditHash:'0'.repeat(64)},{jobs:f.config.binding.jobs.map((j,i)=>i===7?{...j,sampleId:'wrong'}:j)},{phase:'task8'},{cohortHash:'0'.repeat(64)},{promptHashes:{}},{version:'other'},{endpoint:'https://other.openai.azure.com/openai/v1'},{quote_id:'other'},{deployment:'other'}])await expect(createAzureJudgeRoute({...f.config,binding:{...f.config.binding,...patch} as never})).rejects.toMatchObject({code:expect.stringMatching(/configuration|budget_denied/)});
 const route=await createAzureJudgeRoute(f.config);expect(()=>createRouter({local:route})).toThrow();
 expect(()=>createRouter({azureJudge:{...route,provider:'openai'}})).toThrow();
 const client=createRouter({azureJudge:route});await expect(collect(client,f.profile.requests[6]!,6)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(0);
 await collect(client,f.profile.requests[0]!);await expect(collect(client,f.profile.requests[0]!,0)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(1);
});
it('unknown, malformed usage, overrun and HTTP errors stop forever without router retries',async()=>{
 for(const raw of [sse('{}',null),sse('{}',{prompt_tokens:true,completion_tokens:1}),sse('{}',{prompt_tokens:4097,completion_tokens:1}),sse('{}',{prompt_tokens:1,completion_tokens:1025})]){
  const f=fixture();respond(raw);const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
  await expect(collect(client,f.profile.requests[0]!)).rejects.toMatchObject({code:'budget_denied',providerResponse:{raw}});
  const count=dispatches;await expect(collect(client,f.profile.requests[1]!,1)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(count);expect(item(f.config.ledger).status).toBe('failed');expect(item(f.config.ledger).attempts).toHaveLength(1);
 }
 const f=fixture();vi.stubGlobal('fetch',async()=>{dispatches++;return new Response('raw synthetic HTTP failure',{status:503});});const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 await expect(collect(client,f.profile.requests[0]!)).rejects.toMatchObject({providerResponse:{raw:'raw synthetic HTTP failure'},accounting:{costStatus:'unknown',attempts:[{attempt:1}]}});expect(item(f.config.ledger).status).toBe('failed');
});
it('five reproduction calls have no schema retry; later schema recovery is explicit and valid adverse verdict is final',async()=>{
 const bad=fixture();respond(sse('malformed'));const c=createRouter({azureJudge:await createAzureJudgeRoute(bad.config)});
 await expect(collect(c,bad.profile.requests[0]!)).rejects.toMatchObject({judgeOutcome:'invalid-schema',providerResponse:{raw:sse('malformed')},accounting:{costStatus:'known'}});expect(item(bad.config.ledger)).toMatchObject({status:'failed',invalid_schema_count:1});
 const f=fixture();respond();const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 for(let n=0;n<5;n++)await collect(client,f.profile.requests[n]!,n);
 respond(sse('malformed'));const invalid=await collect(client,f.profile.requests[5]!,5);expect(invalid.text).toBe('malformed');expect(item(f.config.ledger)).toMatchObject({next_logical:5,invalid_schema_count:1,cost_status:'known'});
 respond();const valid=await collect(client,f.profile.requests[5]!,5);expect(valid.text).toContain('"fail"');const before=dispatches;
 await expect(collect(client,f.profile.requests[5]!,5)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(before);expect(item(f.config.ledger).attempts).toHaveLength(7);expect(pacing.starts).toBe(dispatches);expect(invalid.providerResponse?.dispatch?.intervalMs).toBe(4000);expect(valid.providerResponse?.dispatch?.intervalMs).toBe(4000);
});
it('concurrent physical consume cannot open a second fetch; pending crash becomes permanent stop',async()=>{
 const f=fixture();let release:()=>void=()=>{};let fetched:()=>void=()=>{};const started=new Promise<void>(r=>{fetched=r;}),hold=new Promise<void>(r=>{release=r;});
 vi.stubGlobal('fetch',async()=>{dispatches++;fetched();await hold;return new Response(sse(),{headers:{'content-type':'text/event-stream'}});});
 const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)}),first=collect(client,f.profile.requests[0]!);await started;
 await expect(collect(client,f.profile.requests[0]!)).rejects.toMatchObject({code:'budget_denied'});release();await first;
 expect(dispatches).toBe(1);expect(item(f.config.ledger)).toMatchObject({status:'failed',cost_status:'known'});
 await expect(collect(client,f.profile.requests[1]!,1)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(1);
});
it('settlement failure retains raw known accounting and an unrecoverable pending exposure',async()=>{
 const f=fixture();vi.stubGlobal('fetch',async()=>{dispatches++;const ledger=JSON.parse(readFileSync(f.config.ledger,'utf8'));ledger.reservations[0].estimate_usd='0';writeFileSync(f.config.ledger,JSON.stringify(ledger));return new Response(sse(),{headers:{'content-type':'text/event-stream'}});});
 const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 await expect(collect(client,f.profile.requests[0]!)).rejects.toMatchObject({code:'budget_denied',providerResponse:{raw:sse()},accounting:{costStatus:'known',costUsd:(2*0.4+1*1.6)/1e6}});
 await expect(collect(client,f.profile.requests[1]!,1)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(1);expect(item(f.config.ledger).attempts[0].settled).toBe(false);
});
it('direct commercial CLI tracing emits durable bounded metadata-only spans with call accounting IDs',async()=>{
 const {startCommercialTracing}=await import('../../../services/api/src/routes/commercialJudge.js');
 const path=join(temp,`spans-${++sequence}.jsonl`),trace=startCommercialTracing(path),f=fixture();respond();
 try{
  const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
  for await(const _chunk of client.stream(f.profile.requests[0]!,{signal:AbortSignal.timeout(5000),commercialLogical:0,run_id:'123e4567-e89b-12d3-a456-426614174000',call_id:'123e4567-e89b-12d3-a456-426614174000:1'})){}
  await trace.forceFlush();expect(trace.failed()).toBe(false);
  const raw=readFileSync(path,'utf8'),span=JSON.parse(raw);expect(span).toMatchObject({name:'llm',attributes:{'gen_ai.provider.name':'azureCommercial','gen_ai.request.model':policy.deployment,'keel.call_id':'123e4567-e89b-12d3-a456-426614174000:1','keel.attempt_count':1,'keel.cost_status':'known'}});
  expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);expect(raw).not.toMatch(/synthetic-private-key|Synthetic adverse verdict|synthetic-0|openai.azure.com|api-key|response_format/);
  expect(()=>startCommercialTracing(path)).toThrow();
 }finally{await trace.shutdown();}
});
it('reserved alias and exact judge host cannot use an unguarded generic provider route',()=>{
 for(const alias of ['azureJudge','renamed'])expect(()=>createRouter({[alias]:{provider:'openai',endpoint:policy.endpoint,model:policy.deployment,apiKey:'synthetic-private-key',pricing:{inputPerMillion:0.4,outputPerMillion:1.6}}})).toThrow();
 expect(()=>createRouter({azureJudge:{provider:'openaiCompatible',endpoint:'http://127.0.0.1:19000/v1',model:'synthetic',pricing:{inputPerMillion:0,outputPerMillion:0}}})).toThrow();
});

it('pre-response network failure preserves raw as unknown and durably stops with one consumed attempt',async()=>{
 const f=fixture();vi.stubGlobal('fetch',async()=>{dispatches++;throw new Error('synthetic network failure');});
 const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 await expect(collect(client,f.profile.requests[0]!)).rejects.toMatchObject({providerResponse:{raw:null,complete:false,settlementStatus:'unknown'},accounting:{costStatus:'unknown',costUsd:0,attempts:[{costStatus:'unknown'}]}});
 expect(dispatches).toBe(1);expect(item(f.config.ledger)).toMatchObject({status:'failed',cost_status:'unknown',known_cost_usd:'0'});
});

it('malformed UTF-8 survives the real gate, failed report and private checkpoint without retry or next dispatch',async()=>{
 const {runCommercialJudge}=await import('../../evals/src/commercialJudge.js');
 const {persistCommercialEvent}=await import('../../../services/api/src/routes/commercialJudge.js');
 const f=fixture(),bytes=Uint8Array.from([100,97,116,97,58,32,255,10,10]);
 const pending=join(temp,`malformed-${++sequence}.pending`);writeFileSync(pending,'{}',{mode:0o600});
 const events:import('../../evals/src/commercialJudge.js').CommercialEvent[]=[];
 vi.stubGlobal('fetch',async()=>{dispatches++;return new Response(bytes,{headers:{'content-type':'text/event-stream'}});});
 const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 const result=await runCommercialJudge({client,profile:f.profile,pricing:{inputPerMillion:0.4,outputPerMillion:1.6},checkpoint:event=>persistCommercialEvent(pending,{},events,event,false)});
 expect(result).toMatchObject({status:'failed',physicalAttempts:1,logicalCompleted:0,costStatus:'unknown',calibration:null});
 const evidence={encoding:'base64',data:Buffer.from(bytes).toString('base64'),receivedBytes:9,capturedBytes:9,truncated:false,textEncoding:'invalid-utf-8'};
 expect(result.attempts[0]).toMatchObject({rawResponse:null,rawResponseComplete:false,rawResponseBytes:evidence,outcome:'failed'});
 const stored=JSON.parse(readFileSync(pending,'utf8'));expect(stored.events.at(-1).attempt.rawResponseBytes).toEqual(evidence);
 const report=join(temp,`malformed-${sequence}.json`);writeFileSync(report,canonical(result),{mode:0o600});expect(JSON.parse(readFileSync(report,'utf8')).attempts[0].rawResponseBytes).toEqual(evidence);
 expect(dispatches).toBe(1);expect(item(f.config.ledger)).toMatchObject({status:'failed',cost_status:'unknown',known_cost_usd:'0'});expect(item(f.config.ledger).attempts).toHaveLength(1);
 await expect(collect(client,f.profile.requests[1]!,1)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(1);
});

it('over-limit received bytes retain only the bounded prefix and mark truncation honestly',async()=>{
 const f=fixture(),bytes=new Uint8Array(1_000_009).fill(97);vi.stubGlobal('fetch',async()=>{dispatches++;return new Response(bytes,{headers:{'content-type':'text/event-stream'}});});
 const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 const failure=await collect(client,f.profile.requests[0]!).then(()=>{throw new Error('expected failure');},error=>error);
 expect(failure.providerResponse).toMatchObject({raw:null,complete:false,bytes:{encoding:'base64',receivedBytes:1_000_009,capturedBytes:1_000_000,truncated:true,textEncoding:'undetermined'}});
 const retained=Buffer.from(failure.providerResponse.bytes.data,'base64');expect(retained.byteLength).toBe(1_000_000);expect(retained[0]).toBe(97);expect(retained.at(-1)).toBe(97);
 await expect(collect(client,f.profile.requests[1]!,1)).rejects.toMatchObject({code:'budget_denied'});expect(dispatches).toBe(1);expect(item(f.config.ledger).status).toBe('failed');
});
it('malformed HTTP error bytes are lossless and complete without replacement text',async()=>{
 const f=fixture(),bytes=Uint8Array.from([255,0,128]);vi.stubGlobal('fetch',async()=>{dispatches++;return new Response(bytes,{status:503});});
 const client=createRouter({azureJudge:await createAzureJudgeRoute(f.config)});
 await expect(collect(client,f.profile.requests[0]!)).rejects.toMatchObject({providerResponse:{raw:null,complete:true,bytes:{encoding:'base64',data:Buffer.from(bytes).toString('base64'),receivedBytes:3,capturedBytes:3,truncated:false,textEncoding:'invalid-utf-8'}}});
 expect(dispatches).toBe(1);expect(item(f.config.ledger).status).toBe('failed');
});
it('valid split UTF-8 preserves the exact legacy response text and hash',async()=>{
 const f=fixture(),raw=sse(JSON.stringify({label:'pass',rationale:'证据🙂'})),bytes=Buffer.from(raw),split=bytes.indexOf(0xf0)+2;
 vi.stubGlobal('fetch',async()=>{dispatches++;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,split));controller.enqueue(bytes.subarray(split));controller.close();}}),{headers:{'content-type':'text/event-stream'}});});
 const result=await collect(createRouter({azureJudge:await createAzureJudgeRoute(f.config)}),f.profile.requests[0]!);
 expect(result.providerResponse).toMatchObject({raw,complete:true,bytes:{encoding:'base64',receivedBytes:bytes.byteLength,capturedBytes:bytes.byteLength,truncated:false,textEncoding:'utf-8'}});
 expect(hash(result.providerResponse!.raw!)).toBe(hash(raw));expect(Buffer.from(result.providerResponse!.bytes!.data,'base64')).toEqual(bytes);expect(item(f.config.ledger)).toMatchObject({next_logical:1,cost_status:'known'});
});
it('valid HTTP error text preserves its existing BOM and UTF-8 semantics',async()=>{
 const f=fixture(),raw='\ufeffHTTP 失败';vi.stubGlobal('fetch',async()=>{dispatches++;return new Response(Buffer.from(raw),{status:503});});
 await expect(collect(createRouter({azureJudge:await createAzureJudgeRoute(f.config)}),f.profile.requests[0]!)).rejects.toMatchObject({providerResponse:{raw,complete:true,bytes:{encoding:'base64',data:Buffer.from(raw).toString('base64'),truncated:false,textEncoding:'utf-8'}}});
 expect(dispatches).toBe(1);
});
it('incomplete UTF-8 at EOF retains bytes and never invents empty decoded text',async()=>{
 const f=fixture(),bytes=Uint8Array.of(0xc3);vi.stubGlobal('fetch',async()=>{dispatches++;return new Response(bytes,{headers:{'content-type':'text/event-stream'}});});
 await expect(collect(createRouter({azureJudge:await createAzureJudgeRoute(f.config)}),f.profile.requests[0]!)).rejects.toMatchObject({providerResponse:{raw:null,complete:true,bytes:{encoding:'base64',data:Buffer.from(bytes).toString('base64'),receivedBytes:1,capturedBytes:1,truncated:false,textEncoding:'invalid-utf-8'}}});
 expect(dispatches).toBe(1);expect(item(f.config.ledger).status).toBe('failed');
});
