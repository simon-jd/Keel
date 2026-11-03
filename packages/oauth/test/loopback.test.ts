import { request } from 'node:http';
import { connect } from 'node:net';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { startLoopback, type LoopbackHandle } from '../src/loopback.js';
import { readPrivateConfig, withCliWatchdog } from '../src/loopbackCli.js';

const live: LoopbackHandle[] = [];
const dirs: string[] = [];
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'keel-slack-loopback-synthetic-')); await (await import('node:fs/promises')).chmod(dir, 0o700); dirs.push(dir); return dir; }
afterEach(async () => { for (const handle of live.splice(0)) await handle.cancel(); for (const dir of dirs.splice(0)) await rm(dir, { recursive:true, force:true }); vi.useRealTimers(); });
function get(path: string, headers: Record<string,string> = {}) { return new Promise<{status:number;body:string;headers:Record<string,unknown>}>(resolve => { const req=request({host:'127.0.0.1',port:19101,path,headers:{Host:'localhost:19101',...headers},agent:false},res=>{ const chunks:Buffer[]=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString(),headers:res.headers})); }); req.on('error',()=>resolve({status:0,body:'',headers:{}})); req.end(); }); }
function raw(wire:string) { return new Promise<string>(resolve=>{ const socket=connect(19101,'127.0.0.1'); let result=''; socket.setTimeout(1000,()=>socket.destroy()); socket.on('connect',()=>socket.end(wire)); socket.on('data',d=>result+=d.toString()); socket.on('close',()=>resolve(result)); socket.on('error',()=>resolve(result)); }); }
const state = 's'.repeat(43);
function service() { return {start:vi.fn(async()=>({authUrl:'https://slack.com/oauth/v2/authorize?private=auth',state})),callback:vi.fn(async():Promise<unknown>=>({accessToken:'private-token',refreshToken:'private-refresh',expiresAt:null,scopes:['search:read','chat:write'],identity:'slack-user' as const}))}; }

test('probe has only health, private durable same-session receipt, and zero OAuth calls', async()=>{
  const dir=await fixture(); const s=service(); const h=await startLoopback({mode:'probe',directory:dir,service:s}); live.push(h);
  const health=await get('/health'); expect(health.status).toBe(200); const id=JSON.parse(health.body).sessionId; expect(id).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(health.headers['cache-control']).toBe('no-store'); expect(health.headers['referrer-policy']).toBe('no-referrer');
  expect((await get('/health')).status).toBe(200);
  const receipt=JSON.parse(await readFile(h.receiptPath,'utf8')); expect(receipt).toEqual({sessionId:id,time:expect.any(String),count:2,status:'reached'});
  expect((await stat(h.receiptPath)).mode & 0o777).toBe(0o600); expect(await get('/oauth/slack/callback?code=x&state='+state)).toMatchObject({status:404});
  expect(s.start).not.toHaveBeenCalled(); expect(s.callback).not.toHaveBeenCalled(); await h.cancel(); expect((await get('/health')).status).toBe(0);
});

test('valid callback exchanges once; malformed, wrong host/state, duplicates and replay never dispatch',async()=>{
  const dir=await fixture(); const s=service(); const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState:async()=>{},authUrlPath:join(dir,'auth-url')}); live.push(h);
  expect(s.start).toHaveBeenCalledWith('slack','keel-slack-sandbox-20261025',['search:read','chat:write']);
  expect((await stat(join(dir,'auth-url'))).mode & 0o777).toBe(0o600);
  const bad=['/?code=x&state='+state,'/oauth/slack/callback?code=x&state=wrong','/oauth/slack/callback?code=x&state='+state+'&state='+state,'/oauth/slack/callback?code=x&state='+state+'&extra=y','/oauth/slack/callback?code=x&state='+state+'&code=y'];
  for(const path of bad) expect((await get(path)).status).toBeGreaterThanOrEqual(400);
  expect((await get('/oauth/slack/callback?code=x&state='+state,{'Host':'evil.test'})).status).toBeGreaterThanOrEqual(400);
  expect(s.callback).not.toHaveBeenCalled();
  const ok=await get('/oauth/slack/callback?code=private-code&state='+state); expect(ok.status).toBe(200); expect(ok.body).not.toMatch(/private|state|token|code/i);
  expect(s.callback).toHaveBeenCalledTimes(1); expect(s.callback).toHaveBeenCalledWith('private-code',state);
  expect((await get('/oauth/slack/callback?code=x&state='+state)).status).toBe(0);
});

test('denial consumes no provider exchange, cancels state, and keeps static response',async()=>{
  const dir=await fixture(); const s=service(); const cancelState=vi.fn(async()=>{}); const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState,authUrlPath:join(dir,'auth-url')}); live.push(h);
  const r=await get('/oauth/slack/callback?error=access_denied&state='+state); expect(r.status).toBe(200); expect(r.body).not.toMatch(/private|state|token|code/i); expect(s.callback).not.toHaveBeenCalled(); expect(cancelState).toHaveBeenCalledTimes(1);
});

test('provider/store failure redacts secrets and records safe outcome',async()=>{
  const dir=await fixture(); const s=service(); s.callback.mockRejectedValueOnce(new Error('private-code private-token private-refresh')); const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState:async()=>{},authUrlPath:join(dir,'auth-url')}); live.push(h);
  const r=await get('/oauth/slack/callback?code=private-code&state='+state); expect(r.status).toBe(500); expect(JSON.stringify(r)).not.toMatch(/private|token|code|refresh/i);
  await h.done; const outcome=await readFile(h.outcomePath!,'utf8'); expect(outcome).toContain('failed'); expect(outcome).not.toMatch(/private|token|code|refresh/i);
});

test('expiry closes unclaimed state; cancellation waits for an in-flight outcome',async()=>{
  const dir=await fixture(); let release!:()=>void; const pending=new Promise<unknown>(resolve=>{release=()=>resolve({accessToken:'private-token',refreshToken:null,expiresAt:null,scopes:[],identity:'slack-user'});});
  const s=service(); s.callback.mockImplementationOnce(()=>pending); const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState:async()=>{},authUrlPath:join(dir,'auth-url'),acceptMs:100,maximumMs:400}); live.push(h);
  const callback=get('/oauth/slack/callback?code=x&state='+state); await vi.waitFor(()=>expect(s.callback).toHaveBeenCalledTimes(1));
  const cancelling=h.cancel(); await new Promise(r=>setTimeout(r,20)); expect((await get('/health')).status).toBe(0); release(); await callback; await cancelling;
  expect(await readFile(h.outcomePath!,'utf8')).toContain('succeeded');
});

test('raw duplicate Host, absolute target, request body and wrong method never dispatch',async()=>{
  const dir=await fixture(), s=service(); const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState:async()=>{},authUrlPath:join(dir,'auth-url')}); live.push(h);
  const target='/oauth/slack/callback?code=x&state='+state;
  const bad=[`GET ${target} HTTP/1.1\r\nHost: localhost:19101\r\nHost: localhost:19101\r\n\r\n`,`GET http://localhost:19101${target} HTTP/1.1\r\nHost: localhost:19101\r\n\r\n`,`POST ${target} HTTP/1.1\r\nHost: localhost:19101\r\nContent-Length: 1\r\n\r\nx`,`GET ${target} HTTP/1.1\r\nHost: localhost:19101\r\nContent-Length: 1\r\n\r\nx`];
  for(const wire of bad) expect(await raw(wire)).not.toMatch(/^HTTP\/1\.1 200/);
  expect(s.callback).not.toHaveBeenCalled();
  expect((await get(target)).status).toBe(200);
});

test('unclaimed expiry cancels state, closes sockets and retains safe audit',async()=>{
  const dir=await fixture(), s=service(), cancelState=vi.fn(async()=>{}); const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState,authUrlPath:join(dir,'auth-url'),acceptMs:25,maximumMs:300}); live.push(h);
  expect(await h.done).toBe('expired'); expect(cancelState).toHaveBeenCalledTimes(1); expect(s.callback).not.toHaveBeenCalled(); expect((await get('/health')).status).toBe(0);
  expect(await readFile(h.outcomePath!,'utf8')).toContain('expired');
});

test('in-flight expiry records unknown after the finite settlement window',async()=>{
  const dir=await fixture(), s=service(); s.callback.mockImplementationOnce(()=>new Promise<unknown>(()=>{}));
  const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState:async()=>{},authUrlPath:join(dir,'auth-url'),acceptMs:25,maximumMs:75}); live.push(h);
  const callback=get('/oauth/slack/callback?code=x&state='+state);
  await vi.waitFor(()=>expect(s.callback).toHaveBeenCalledTimes(1));
  expect(await h.done).toBe('unknown'); await callback;
  expect((await get('/health')).status).toBe(0); expect(await readFile(h.outcomePath!,'utf8')).toContain('unknown');
});

test('private config rejects App ID, extra fields, weak modes and symlinks',async()=>{
  const dir=await fixture(), path=join(dir,'config.json'), keyFile=join(dir,'key');
  const valid={clientId:'synthetic-client',connectionString:'postgres://synthetic@127.0.0.1:5432/synthetic',keyFile};
  await writeFile(path,JSON.stringify(valid),{mode:0o600}); expect(await readPrivateConfig(path,dir)).toEqual(valid);
  await writeFile(path,JSON.stringify({...valid,clientId:'A0SYNTHETIC1'})); await expect(readPrivateConfig(path,dir)).rejects.toThrow('CONFIG_INVALID');
  await writeFile(path,JSON.stringify({...valid,extra:true})); await expect(readPrivateConfig(path,dir)).rejects.toThrow('CONFIG_INVALID');
  await writeFile(path,JSON.stringify(valid)); await chmod(path,0o644); await expect(readPrivateConfig(path,dir)).rejects.toThrow('CONFIG_INVALID');
  await rm(path); await symlink(keyFile,path); await expect(readPrivateConfig(path,dir)).rejects.toThrow();
});

test('private PG configuration rejects parser query overrides and file reads',async()=>{
  const dir=await fixture(), path=join(dir,'config.json'), keyFile=join(dir,'key');
  const base={clientId:'synthetic-client',connectionString:'postgres://synthetic@127.0.0.1:5432/synthetic',keyFile};
  await writeFile(path,JSON.stringify(base),{mode:0o600});
  for(const suffix of ['?host=example.test','?host=%2Ftmp%2Fother-socket','?sslcert=%2Ftmp%2Fother-cert','?sslkey=%2Ftmp%2Fother-key','?sslrootcert=%2Ftmp%2Fother-root']) {
    await writeFile(path,JSON.stringify({...base,connectionString:base.connectionString+suffix}));
    await expect(readPrivateConfig(path,dir)).rejects.toThrow('CONFIG_INVALID');
  }
});

test('health work has a finite accepted request budget',async()=>{
  const dir=await fixture(), h=await startLoopback({directory:dir}); live.push(h);
  for(let i=0;i<8;i++) expect((await get('/health')).status).toBe(200);
  expect((await get('/health')).status).toBe(429);
  expect(JSON.parse(await readFile(h.receiptPath,'utf8')).count).toBe(8);
});

test('health permits one receipt write in flight and queues no stranger work',async()=>{
  const dir=await fixture(); let release!:()=>void;
  const writer=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
  const h=await startLoopback({directory:dir,receiptWriter:writer}); live.push(h);
  const first=get('/health'); await vi.waitFor(()=>expect(writer).toHaveBeenCalledTimes(1));
  expect((await get('/health')).status).toBe(503); expect(writer).toHaveBeenCalledTimes(1);
  release(); expect((await first).status).toBe(200); await h.cancel();
});

test('hung receipt write settles unknown by absolute deadline without draining an async tail',async()=>{
  const dir=await fixture(), writer=vi.fn(()=>new Promise<void>(()=>{}));
  const h=await startLoopback({directory:dir,receiptWriter:writer,acceptMs:25,maximumMs:90}); live.push(h);
  const first=get('/health'); await vi.waitFor(()=>expect(writer).toHaveBeenCalledTimes(1));
  expect(await h.done).toBe('unknown'); expect((await first).status).toBe(0);
  expect(JSON.parse(await readFile(h.receiptPath,'utf8'))).toMatchObject({count:0,status:'pending'});
});

test('hung final audit preserves the prewritten unknown after a synthetic exchange',async()=>{
  const dir=await fixture(), s=service(), writer=vi.fn(()=>new Promise<void>(()=>{}));
  const h=await startLoopback({mode:'real',directory:dir,service:s,cancelState:async()=>{},authUrlPath:join(dir,'auth-url'),outcomeWriter:writer,acceptMs:100,maximumMs:180}); live.push(h);
  expect((await get('/oauth/slack/callback?code=x&state='+state)).status).toBe(200);
  await vi.waitFor(()=>expect(writer).toHaveBeenCalledTimes(1));
  expect(await h.done).toBe('unknown'); expect(s.callback).toHaveBeenCalledTimes(1);
  const audit=JSON.parse(await readFile(h.outcomePath!,'utf8')); expect(audit.status).toBe('unknown'); expect(JSON.stringify(audit)).not.toMatch(/private|token|code|refresh/i);
});

test('CLI watchdog stays armed through an inert hung pool teardown',async()=>{
  let release!:()=>void; const fakePool={end:vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}))}; const terminate=vi.fn();
  let passedDeadline=0; const work=withCliWatchdog(async deadline=>{passedDeadline=deadline; await fakePool.end();},terminate,25);
  await vi.waitFor(()=>expect(terminate).toHaveBeenCalledTimes(1));
  expect(passedDeadline).toBeGreaterThan(0); expect(fakePool.end).toHaveBeenCalledTimes(1); release(); await work;
});

test('late real startup preserves the remaining settlement reserve before OAuth start',async()=>{
  const dir=await fixture(), s=service();
  await expect(startLoopback({mode:'real',directory:dir,service:s,cancelState:async()=>{},authUrlPath:join(dir,'auth-url'),acceptMs:50,maximumMs:100,absoluteDeadlineMs:Date.now()+20})).rejects.toThrow('LIFETIME_INVALID');
  expect(s.start).not.toHaveBeenCalled();
});
