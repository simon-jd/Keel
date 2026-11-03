import { afterEach, expect, test, vi } from 'vitest';
import { createCrossEncoder, createEmbeddingClient, embeddingProfile, scoreRelevance } from '../src/rag.js';
import type { CallAccounting, ModelClient } from '../src/types.js';
const profile=embeddingProfile({alias:'fixture',provider:'openaiCompatible',model:'fixture-embed',revision:'fixture-rev',dimension:3,runtimeEvidence:'fixture-only'});
afterEach(()=>vi.unstubAllGlobals());
test('embeddings validate identity, order, finite nonzero dimension, usage and preserve unknown physical failures',async()=>{
 let calls=0;const events:CallAccounting[]=[];
 vi.stubGlobal('fetch',vi.fn(async()=>{calls++;return new Response(JSON.stringify({model:'fixture-embed',data:[{index:1,embedding:[0,1,0]},{index:0,embedding:[1,0,0]}],usage:{prompt_tokens:4,total_tokens:4}}),{headers:{'content-type':'application/json'}});}));
 const client=createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1',observer:a=>{events.push(a);}});
 expect((await client.embed(['one','two'],{signal:new AbortController().signal})).vectors).toEqual([[1,0,0],[0,1,0]]);
 expect(events[0]).toMatchObject({costUsd:0,costStatus:'known',attempts:[{outcome:'success'}]});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({model:'fixture-embed',data:[{index:0,embedding:[0,0,0]}]}))));
 await expect(client.embed(['one'],{signal:new AbortController().signal})).rejects.toMatchObject({code:'protocol',accounting:{costStatus:'unknown',attempts:[{outcome:'failed'}]}});
 expect(calls).toBe(1);
 expect(()=>createEmbeddingClient({profile,endpoint:'https://external.example/v1'})).toThrow();
});
test('model API relevance scorer uses strict JSON and carries successful accounting on malformed predictions',async()=>{
 const accounting={model:'fixture-score',provider:'openaiCompatible',status:'success',costUsd:0,costStatus:'known',usage:{input:1,output:1},attempts:[{attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage:{input:1,output:1}}]} as const;
 const client:ModelClient={async *stream(req){expect(req.temperature).toBe(0);expect(req.seed).toBe(0);expect(req.maxTokens).toBe(128);yield {text:'{"score":0.9}',accounting:structuredClone(accounting) as unknown as CallAccounting};}};
 expect((await scoreRelevance(client,'fixture','q','doc',{signal:new AbortController().signal})).score).toBe(.9);
 const bad:ModelClient={async *stream(){yield {text:'{"score":2}',accounting:structuredClone(accounting) as unknown as CallAccounting};}};
 await expect(scoreRelevance(bad,'fixture','q','doc',{signal:new AbortController().signal})).rejects.toMatchObject({code:'protocol',accounting:{costStatus:'known'}});
});
test('embedding physical attempts never retry, usage absence stays unknown and input cancellation dispatches nothing',async()=>{
 const dispatch=vi.fn(async()=>new Response('untrusted error',{status:503}));vi.stubGlobal('fetch',dispatch);
 const client=createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1'});
 await expect(client.embed(['a'],{signal:new AbortController().signal})).rejects.toMatchObject({code:'http',accounting:{attempts:[{attempt:1,outcome:'failed',costStatus:'unknown'}]}});expect(dispatch).toHaveBeenCalledTimes(1);
 const controller=new AbortController();controller.abort();await expect(client.embed(['a'],{signal:controller.signal})).rejects.toMatchObject({code:'aborted'});expect(dispatch).toHaveBeenCalledTimes(1);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({model:profile.model,data:[{index:0,embedding:[1,0,0]}]}),{headers:{'content-type':'application/json'}})));
 expect((await client.embed(['a'],{signal:new AbortController().signal})).accounting.costStatus).toBe('unknown');
});
test.each([[1,0],[1,Infinity,0],[0,0,0]].map(vector=>[vector]))('invalid embedding vector %j cannot reach RAG storage',async(vector)=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({model:profile.model,data:[{index:0,embedding:vector}],usage:{prompt_tokens:1,total_tokens:1}}),{headers:{'content-type':'application/json'}})));
 await expect(createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1'}).embed(['a'],{signal:new AbortController().signal})).rejects.toMatchObject({code:'protocol',accounting:{costStatus:'known'}});
});
test('embedding telemetry contains accounting metrics and excludes query/document payloads',async()=>{
 const {configureTracing}=await import('tracing/exporter');const spans:unknown[]=[];
 const tracing=configureTracing({exporter:{export(items,done){spans.push(...items.map(s=>({name:s.name,attributes:s.attributes})));done({code:0});},async shutdown(){}}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({model:profile.model,data:[{index:0,embedding:[1,0,0]}],usage:{prompt_tokens:1,total_tokens:1}}),{headers:{'content-type':'application/json'}})));
 try{await createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1'}).embed(['sensitive-fixture-document'],{signal:new AbortController().signal});await tracing.forceFlush();expect(spans).toHaveLength(1);expect(JSON.stringify(spans)).toContain('keel.attempt_count');expect(JSON.stringify(spans)).not.toMatch(/sensitive-fixture-document|19001|embedding|vector/);}finally{await tracing.shutdown();}
});
test('trusted private embedding key reaches only loopback authorization and never identity, body or results',async()=>{
 const apiKey='private-fixture-key';let body='';
 const dispatch=vi.fn(async(_url:unknown,init:RequestInit)=>{expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${apiKey}`);body=String(init.body);return Response.json({model:profile.model,data:[{index:0,embedding:[1,0,0]}],usage:{prompt_tokens:1,total_tokens:1}});});vi.stubGlobal('fetch',dispatch);
 const client=createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1',apiKey});
 const result=await client.embed(['fixture'],{signal:new AbortController().signal});
 expect(body).not.toContain(apiKey);expect(JSON.stringify({profile:client.profile,result})).not.toContain(apiKey);
 expect(dispatch).toHaveBeenCalledTimes(1);dispatch.mockClear();
 for(const endpoint of ['https://outside.example/v1','http://127.0.0.1:19001/v1?x=1','http://user@127.0.0.1:19001/v1'])expect(()=>createEmbeddingClient({profile,endpoint,apiKey})).toThrow();
 expect(()=>createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1',apiKey:'bad\nkey'})).toThrow();expect(dispatch).not.toHaveBeenCalled();
});
test('embedding truncation is an explicit body field; cross-encoder rerank returns scores in document order',async()=>{
 const bodies:unknown[]=[];const urls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{urls.push(url);bodies.push(JSON.parse(String(init.body)));return new Response(JSON.stringify({model:'fixture-embed',data:[{index:0,embedding:[1,0,0]}],usage:{prompt_tokens:2,total_tokens:2}}),{headers:{'content-type':'application/json'}});}));
 await createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1',truncatePromptTokens:512}).embed(['x'],{signal:new AbortController().signal});
 expect(bodies[0]).toMatchObject({truncate_prompt_tokens:512});
 expect(()=>createEmbeddingClient({profile,endpoint:'http://127.0.0.1:19001/v1',truncatePromptTokens:0})).toThrow();
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{urls.push(url);bodies.push(JSON.parse(String(init.body)));return new Response(JSON.stringify({model:'fixture-rerank',usage:{total_tokens:9},results:[{index:1,relevance_score:0.9},{index:0,relevance_score:0.1}]}),{headers:{'content-type':'application/json'}});}));
 const ce=createCrossEncoder({model:'fixture-rerank',endpoint:'http://127.0.0.1:19002/v1',truncatePromptTokens:512});
 const result=await ce.rerank('q',['a','b'],{signal:new AbortController().signal});
 expect(result.scores).toEqual([0.1,0.9]);expect(result.accounting).toMatchObject({costUsd:0,costStatus:'known',usage:{input:9,output:0}});
 expect(urls.at(-1)).toBe('http://127.0.0.1:19002/v1/rerank');expect(bodies.at(-1)).toEqual({model:'fixture-rerank',query:'q',documents:['a','b'],truncate_prompt_tokens:512});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({model:'fixture-rerank',results:[{index:0,relevance_score:0.1}]}),{headers:{'content-type':'application/json'}})));
 await expect(ce.rerank('q',['a','b'],{signal:new AbortController().signal})).rejects.toMatchObject({code:'protocol'});
 expect(()=>createCrossEncoder({model:'m',endpoint:'https://outside.example/v1'})).toThrow();
});
