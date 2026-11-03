import { afterAll,beforeAll,beforeEach,expect,test } from 'vitest';
import { generateKeyPairSync,randomBytes,verify,createHmac } from 'node:crypto';
import { hash } from 'runtime/actions';
import { startServer } from 'mcp-common/server';
import { ActionJournal } from 'mcp-common/journal';
import { ApprovalAuthority } from 'mcp-common/approval';
import { githubTools } from '../src/index.js';
import { verifyGithubWebhook } from '../src/webhook.js';
import { authConfig,client,database,fixture,jwt } from '../../common/test/helpers.js';
let db:Awaited<ReturnType<typeof database>>;let provider:Awaited<ReturnType<typeof fixture>>;let server:Awaited<ReturnType<typeof startServer>>;let authority:ApprovalAuthority;
const appKeys=generateKeyPairSync('rsa',{modulusLength:2048});const key=randomBytes(32);let mode='ok';let writes=0;let exchanges=0;let resources=0;let issues:Record<string,unknown>[]=[];let checkPages:number[]=[];let checkRefs:string[]=[];
beforeAll(async()=>{
 db=await database();provider=await fixture((req,res,raw)=>{
  const url=new URL(req.url!,'http://fixture');
  if(url.pathname==='/app/installations/123/access_tokens'){
   exchanges++;const token=req.headers.authorization?.slice(7)??'';const [h,p,s]=token.split('.');expect(h&&p&&s).toBeTruthy();expect(verify('RSA-SHA256',Buffer.from(`${h}.${p}`),appKeys.publicKey,Buffer.from(s!,'base64url'))).toBe(true);const claims=JSON.parse(Buffer.from(p!,'base64url').toString()) as {iss:string;iat:number;exp:number};expect(claims.iss).toBe('42');expect(claims.exp-claims.iat).toBeLessThanOrEqual(600);
   const body=JSON.parse(raw.toString()) as Record<string,unknown>;expect(body.repositories).toEqual(['repo']);
   res.statusCode=201;res.end(JSON.stringify({token:`installation-${exchanges}`,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:mode==='missing-permission'?{}:{checks:'read',issues:'write',metadata:'read'},repositories:mode==='wrong-repo'?[{id:2,name:'other',full_name:'fixture/other'}]:[{id:1,name:'repo',full_name:'fixture/repo'}],repository_selection:'selected'}));return;
  }
  resources++;expect(req.headers.authorization).toMatch(/^Bearer installation-\d+$/);expect(req.headers['x-github-api-version']).toBe('2026-03-10');
  if(mode==='always401'||(mode==='unauthorized'&&req.headers.authorization==='Bearer installation-1')){res.statusCode=401;res.end('{}');return;}
  if(url.pathname==='/repos/fixture/repo'){res.end(JSON.stringify({full_name:'fixture/repo',default_branch:'main'}));return;}
  if(url.pathname==='/repos/fixture/repo/commits/main/check-runs'||url.pathname==='/repos/fixture/repo/commits/'+'a'.repeat(40)+'/check-runs'){
   checkRefs.push(url.pathname.split('/')[5]!);
   const page=Number(url.searchParams.get('page'));checkPages.push(page);res.end(JSON.stringify({total_count:101,check_runs:page===1?Array.from({length:100},(_,i)=>({id:i+1,name:'check',status:'completed',conclusion:i===0?'failure':'success',head_sha:'a'.repeat(40)})):[{id:101,name:'timeout',status:'completed',conclusion:'timed_out',head_sha:'a'.repeat(40)}]}));return;
  }
  if(url.pathname==='/repos/fixture/repo/issues'&&req.method==='POST'){
   writes++;const body=JSON.parse(raw.toString()) as Record<string,unknown>;issues.push({number:12,title:body.title,body:body.body,user:{id:420,type:'Bot'},performed_via_github_app:{id:42},repository_url:provider.origin+'/repos/fixture/repo'});if(mode==='lost'){req.socket.destroy();return;}res.statusCode=201;res.end(JSON.stringify({number:12}));return;
  }
  if(url.pathname==='/repos/fixture/repo/issues'){if(mode==='lookup-error'){res.statusCode=503;res.end('{"message":"secret private body"}');return;}res.end(JSON.stringify(issues));return;}
  res.statusCode=404;res.end('{}');
 });
 server=await startServer({name:'github',port:0,auth:authConfig,approvalKey:key,journal:new ActionJournal(db.pool,db.cipher),tools:githubTools({appId:'42',privateKey:appKeys.privateKey,tenants:{'tenant-a':{installationId:123,repositories:['fixture/repo']}},apiBase:provider.origin,timeoutMs:300}),webhook:(raw,headers)=>verifyGithubWebhook(raw,headers.get('x-hub-signature-256')??'','fixture-signing')});authority=new ApprovalAuthority(key,server.url);
});
afterAll(async()=>{await server?.close();await provider?.close();await db?.close();expect(provider?.failures).toEqual([]);});
beforeEach(async()=>{mode='ok';writes=exchanges=resources=0;issues=[];checkPages=[];checkRefs=[];await db.pool.query('DELETE FROM mcp_actions');});
async function proof(args:Record<string,unknown>){const b={tenantId:'tenant-a',runId:'10000000-0000-4000-8000-000000000001',tool:'github.create_issue',actionKey:'b'.repeat(64),argsHash:hash(args)};return authority.issue(b,args,[b],async()=> 'allow');}
// Using a user token, wrong App JWT or omitting pagination would break the fixture's signed token exchange and fail results.
test('SDK reads default-branch failed checks with App installation token and pagination',async()=>{
 const c=await client(server.url);try{expect((await c.listTools()).tools.map(t=>t.name)).toEqual(['list_failing_checks','create_issue']);const r=await c.callTool({name:'list_failing_checks',arguments:{repo:'fixture/repo'}});expect(r.isError).not.toBe(true);expect(JSON.stringify(r)).toContain('timed_out');expect(JSON.stringify(r)).toContain('failure');expect(checkPages).toEqual([1,2]);expect(checkRefs).toEqual(['main','a'.repeat(40)]);expect(exchanges).toBe(1);}finally{await c.close();}
});
test('toolDeniedWhenScopeMissing',async()=>{
 const c=await client(server.url);try{for(const missing of ['missing-permission','wrong-repo']){mode=missing;expect((await c.callTool({name:'list_failing_checks',arguments:{repo:'fixture/repo'}})).isError).toBe(true);expect(resources).toBe(0);}mode='ok';expect((await c.callTool({name:'list_failing_checks',arguments:{repo:'fixture/other'}})).isError).toBe(true);expect(exchanges).toBe(2);}finally{await c.close();}
});
test('installation resource 401 reacquires once and repeated 401 is terminal',async()=>{
 const c=await client(server.url);try{mode='unauthorized';expect((await c.callTool({name:'list_failing_checks',arguments:{repo:'fixture/repo'}})).isError).not.toBe(true);expect(exchanges).toBe(2);mode='always401';exchanges=0;resources=0;expect((await c.callTool({name:'list_failing_checks',arguments:{repo:'fixture/repo'}})).isError).toBe(true);expect(exchanges).toBe(2);expect(resources).toBe(2);}finally{await c.close();}
});
test('create issue requires approval and lost reply reconciles exact App issue without another write',async()=>{
 const args={repo:'fixture/repo',title:'Fixture issue',body:'Fixture body'};const c=await client(server.url);try{expect((await c.callTool({name:'create_issue',arguments:args,_meta:{approved:true}})).isError).toBe(true);expect(exchanges).toBe(0);mode='lost';expect((await c.callTool({name:'create_issue',arguments:args,_meta:{'keel/approval':await proof(args)}})).isError).toBe(true);expect(writes).toBe(1);
 mode='lookup-error';const lookup=()=>fetch(server.origin+'/actions/lookup',{method:'POST',headers:{Authorization:`Bearer ${jwt(server.url)}`},body:JSON.stringify({actionKey:'b'.repeat(64)})});expect((await lookup()).status).toBe(409);mode='ok';expect(await(await lookup()).json()).toEqual({status:'done'});expect(writes).toBe(1);expect(issues[0]?.body).toBe('Fixture body\n<!-- keel-action:'+'b'.repeat(64)+' -->');
 }finally{await c.close();}
});
test('forged or ambiguous issue markers remain UNKNOWN',async()=>{
 const args={repo:'fixture/repo',title:'Fixture issue',body:'Fixture body'};const c=await client(server.url);try{mode='lost';await c.callTool({name:'create_issue',arguments:args,_meta:{'keel/approval':await proof(args)}});mode='ok';expect(issues).toHaveLength(1);issues[0]!.performed_via_github_app={id:999};const response=await fetch(server.origin+'/actions/lookup',{method:'POST',headers:{Authorization:`Bearer ${jwt(server.url)}`},body:JSON.stringify({actionKey:'b'.repeat(64)})});expect(response.status).toBe(409);expect(writes).toBe(1);}finally{await c.close();}
});
test('GitHub webhook route authenticates bytes and never triggers a tool write',async()=>{
 const body='{ "action": "opened" }';const headers={'x-hub-signature-256':'sha256='+createHmac('sha256','fixture-signing').update(body).digest('hex')};expect((await fetch(server.origin+'/webhook',{method:'POST',headers,body:body+' '})).status).toBe(401);for(let n=0;n<2;n++)expect((await fetch(server.origin+'/webhook',{method:'POST',headers,body})).status).toBe(200);expect(writes).toBe(0);
});
