import { afterAll,beforeAll,expect,test } from 'vitest';
import { z } from 'zod';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/server.js';
import { ActionJournal } from '../src/journal.js';
import { authConfig,client,database,jwt } from './helpers.js';
let db:Awaited<ReturnType<typeof database>>;let server:Awaited<ReturnType<typeof startServer>>;
beforeAll(async()=>{db=await database();server=await startServer({name:'fixture',port:0,auth:authConfig,approvalKey:randomBytes(32),journal:new ActionJournal(db.pool,db.cipher),tools:[{name:'read_fixture',schema:z.object({}).strict(),scopes:['fixture:read'],write:false,execute:async()=>({id:'fixture-id'})}]});});
afterAll(async()=>{await server?.close();await db?.close();});
// Removing transport wiring, metadata discovery, auth gates or per-principal factory isolation breaks these observable boundaries.
test('real SDK initializes lists and calls over authenticated Streamable HTTP',async()=>{
 const metadata=await fetch(server.origin+'/.well-known/oauth-protected-resource/mcp');expect(metadata.status).toBe(200);
 expect(await metadata.json()).toMatchObject({resource:server.url,authorization_servers:[authConfig.issuer]});
 const c=await client(server.url);try{expect((await c.listTools()).tools.map(t=>t.name)).toEqual(['read_fixture']);expect(await c.callTool({name:'read_fixture',arguments:{}})).toMatchObject({content:[{type:'text',text:'{"id":"fixture-id"}'}]});}finally{await c.close();}
});
test('challenges missing invalid expired and wrong-resource tokens before dispatch',async()=>{
 for(const token of ['',jwt(server.url,{exp:1}),jwt('https://wrong.example/mcp'),'xoxp-provider-token']){const r=await fetch(server.url,{headers:token?{Authorization:`Bearer ${token}`}:{}});expect(r.status).toBe(401);expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');expect(await r.text()).not.toContain(token||'xoxp');}
 expect((await fetch(server.url,{headers:{Authorization:`Bearer ${jwt(server.url,{scope:'other'})}`}})).status).toBe(403);
});
test('rejects hostile Host Origin and oversized requests',async()=>{
 for(const headers of [{Host:'evil.example'},{Origin:'https://evil.example'}]) { const status=await new Promise<number|undefined>((resolve,reject)=>{const r=request(server.url,{headers},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});expect(status).toBe(403); }
 const r=await fetch(server.url,{method:'POST',headers:{Authorization:`Bearer ${jwt(server.url)}`,'content-type':'application/json'},body:'x'.repeat(70000)});expect(r.status).toBe(413);
});

// The public handler must also serve actual initialize/list/call clients using the supported legacy HTTP revision.
test('serves SDK initialize handshake and tools on the 2025 HTTP revision',async()=>{
 const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');const methods:string[]=[];
 const c=new Client({name:'legacy-fixture',version:'1.0.0'},{supportedProtocolVersions:['2025-11-25']});
 try{
  await c.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:{Authorization:`Bearer ${jwt(server.url)}`}},fetch:async(input,init)=>{if(typeof init?.body==='string'){const body=JSON.parse(init.body) as {method?:string};if(body.method)methods.push(body.method);}return fetch(input,init);}}));
  expect((await c.listTools()).tools.map(t=>t.name)).toEqual(['read_fixture']);expect((await c.callTool({name:'read_fixture',arguments:{}})).isError).not.toBe(true);expect(methods).toContain('initialize');expect(methods).toContain('tools/list');expect(methods).toContain('tools/call');
 }finally{await c.close();}
});
