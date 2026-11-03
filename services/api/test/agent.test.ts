import { expect, test } from 'vitest';
import { createAgentApp } from '../src/routes/agent.js';
import type { ModelClient } from 'models/types';
const token = 'a'.repeat(32);
const body = {messages:[{role:'user',content:'hello'}], model:'local'};
const request = (data: unknown, auth = token) => new Request('http://localhost/v1/agent/step', {method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify(data)});
test('preserves structured calls and bounds the model dispatch', async () => {
  let calls = 0;
  const model: ModelClient = { async *stream(req) { calls++; expect(req.maxTokens).toBe(2048); yield {toolCalls:[{id:'call-a',name:'lookup',args:{id:7}}],usage:{input:3,output:4}}; } };
  const app = createAgentApp({model, token, maxRequests:1});
  const response = await app.fetch(request({...body,tools:[{name:'lookup',parameters:{type:'object'}}]}));
  expect(response.status).toBe(200);
  expect((await response.json()).action.toolCalls).toEqual([{id:'call-a',name:'lookup',args:{id:7}}]);
  expect((await app.fetch(request(body))).status).toBe(429); expect(calls).toBe(1);
});
test('maxConcurrent admits that many in-flight dispatches and no more; default stays serial', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let inFlight = 0; let peak = 0;
  const model: ModelClient = { async *stream() { inFlight++; peak = Math.max(peak, inFlight); await gate; inFlight--; yield {text:'ok'}; } };
  const app = createAgentApp({model, token, maxRequests:20000, maxConcurrent:2});
  const first = [app.fetch(request(body)), app.fetch(request(body))];
  await new Promise(resolve => setTimeout(resolve, 10));
  expect((await app.fetch(request(body))).status).toBe(429);
  release();
  expect((await Promise.all(first)).map(r => r.status)).toEqual([200, 200]); expect(peak).toBe(2);
  expect((await app.fetch(request(body))).status).toBe(200);
  const serial = createAgentApp({model:{async *stream(){await new Promise(resolve=>setTimeout(resolve,20));yield {text:'ok'};}}, token, maxRequests:4});
  const pending = serial.fetch(request(body)); await new Promise(resolve => setTimeout(resolve, 5));
  expect((await serial.fetch(request(body))).status).toBe(429); expect((await pending).status).toBe(200);
  for (const bad of [0, 65, 1.5]) expect(() => createAgentApp({model, token, maxRequests:1, maxConcurrent:bad})).toThrow('INVALID_API_CONFIGURATION');
  expect(() => createAgentApp({model, token, maxRequests:200001})).toThrow('INVALID_API_CONFIGURATION');
});
test('rejects unauthenticated, arbitrary routing and oversized inputs before dispatch', async () => {
  let calls = 0;
  const app = createAgentApp({model:{async *stream(){calls++;yield {text:'bad'};}},token,maxRequests:4});
  expect((await app.fetch(request(body,'bad'))).status).toBe(401);
  for (const bad of [{...body,endpoint:'https://evil.test'}, {...body,model:'paid'}, {...body,maxTokens:999999}, {...body,messages:[{role:'tool',content:'x'}]}, {...body,messages:[{role:'user',content:'x'.repeat(1_100_000)}]}]) expect((await app.fetch(request(bad))).status).toBeGreaterThanOrEqual(400);
  expect(calls).toBe(0);
});
test('trusted benchmark option preserves mixed unknown order; default and caller remain strict',async()=>{
 const model:ModelClient={async *stream(){yield {toolCalls:[{id:'v',name:'lookup',args:{}}],invalidToolCalls:[{id:'u',name:'missing',error:'unknown_tool',args:{}}],toolCallOrder:['u','v']};}};
 const strict=createAgentApp({model,token,maxRequests:4});
 expect((await strict.fetch(request(body))).status).toBe(502);
 expect((await strict.fetch(request({...body,benchmarkUnknownTools:true}))).status).toBe(400);
 const app=createAgentApp({model,token,maxRequests:4,benchmarkUnknownTools:true});
 const response=await app.fetch(request(body));expect(response.status).toBe(200);
 const result=await response.json();expect(result.action.toolCalls.map((c:{id:string})=>c.id)).toEqual(['u','v']);expect(result.invalidToolCalls[0].error).toBe('unknown_tool');
 const malformed=createAgentApp({model:{async *stream(){yield {invalidToolCalls:[{id:'bad',name:'lookup',error:'malformed_json'}]};}},token,maxRequests:1,benchmarkUnknownTools:true});
 expect((await malformed.fetch(request(body))).status).toBe(502);
});
test('commercial identity is authenticated and admission errors remain distinct without provider data',async()=>{
 const identity={bindingHash:'a'.repeat(64),reservationId:'fixture-reservation'};
 const local=createAgentApp({model:{async *stream(){yield {}; }},token,maxRequests:1});
 expect((await local.fetch(new Request('http://localhost/v1/agent/identity',{headers:{authorization:`Bearer ${token}`}}))).status).toBe(404);
 for(const [code,error] of [['budget_exhausted','BUDGET_EXHAUSTED'],['budget_denied','BUDGET_DENIED'],['invalid_request','MODEL_INPUT_REJECTED']]){
  const app=createAgentApp({model:{async *stream(){throw Object.assign(new Error('private-error'),{code,accounting:{attempts:[],costUsd:0,costStatus:'known'}});}},token,maxRequests:1,benchmarkIdentity:identity});
  expect((await app.fetch(new Request('http://localhost/v1/agent/identity'))).status).toBe(401);
  const result=await app.fetch(new Request('http://localhost/v1/agent/identity',{headers:{authorization:`Bearer ${token}`}}));
  expect(await result.json()).toEqual(identity);
  const rejected=await (await app.fetch(request(body))).json();expect(rejected.error).toBe(error);expect(rejected.accounting.attempts).toEqual([]);expect(JSON.stringify(rejected)).not.toContain('private-error');
 }
});
