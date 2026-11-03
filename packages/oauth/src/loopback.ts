import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, rename } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';

export const SLACK_LOOPBACK_REDIRECT = 'http://localhost:19101/oauth/slack/callback';
export const SLACK_LOOPBACK_TENANT = 'keel-slack-sandbox-20261025';
const SCOPES = ['search:read', 'chat:write'];
type StartResult = { authUrl: string; state: string };
type CallbackService = { start(provider:'slack',tenant:string,scopes:string[]):Promise<StartResult>; callback(code:string,state:string):Promise<unknown> };
type Mode = 'probe' | 'real';
export interface LoopbackOptions {
  mode?: Mode;
  directory: string;
  service?: CallbackService;
  cancelState?: () => Promise<void>;
  authUrlPath?: string;
  /** Internal finite-test clocks; the trusted CLI never exposes these values. */
  acceptMs?: number;
  maximumMs?: number;
  /** Internal CLI deadline, armed before any private I/O. */
  absoluteDeadlineMs?: number;
  /** Inert finite-test seams; the trusted CLI always uses the durable writer. */
  receiptWriter?: (path:string,value:unknown)=>Promise<void>;
  outcomeWriter?: (path:string,value:unknown)=>Promise<void>;
}
export interface LoopbackHandle { sessionId:string; receiptPath:string; outcomePath?:string; done:Promise<string>; cancel():Promise<void> }
type SafeStatus = 'reached' | 'pending' | 'succeeded' | 'denied' | 'failed' | 'expired' | 'cancelled' | 'unknown';

export async function verifyPrivateDirectory(directory:string):Promise<void> {
  const s=await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777)!==0o700) throw new Error('PRIVATE_DIRECTORY_INVALID');
}
async function createPrivateFile(path:string, content:string):Promise<void> {
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  const parent=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
function page(res:ServerResponse,status:number,body:string):void {
  if(res.destroyed || res.headersSent) return;
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Connection':'close'});
  res.end(`<!doctype html><meta charset="utf-8"><title>Status</title><p>${body}</p>`);
}
function responseDone(res:ServerResponse):Promise<void> {
  if(res.writableFinished || res.destroyed) return Promise.resolve();
  return new Promise(resolve=>{res.once('finish',resolve);res.once('close',resolve);});
}
function validRequest(req:IncomingMessage):boolean {
  const raw=req.rawHeaders;
  let hosts=0, size=0;
  for(let i=0;i<raw.length;i+=2) { const name=raw[i]!,value=raw[i+1]!; size+=name.length+value.length; if(name.toLowerCase()==='host') { hosts++; if(value!=='localhost:19101') return false; } }
  return hosts===1 && raw.length/2<=20 && size<=4096 && req.method==='GET' && !req.headers['content-length'] && !req.headers['transfer-encoding'] && !!req.url && req.url.length<=2048 && req.url.startsWith('/') && !req.url.startsWith('//') && !req.url.includes('#');
}
function query(raw:string,state:string): {kind:'code'|'denied';code?:string}|null {
  if(!raw.startsWith('/oauth/slack/callback?')) return null;
  const q=raw.slice('/oauth/slack/callback?'.length);
  if(!q || q.length>2048 || /%(?![0-9A-Fa-f]{2})/.test(q)) return null;
  const p=new URLSearchParams(q); const keys=[...p.keys()];
  if(keys.length!==2 || new Set(keys).size!==2 || !keys.includes('state')) return null;
  const received=p.get('state')!;
  if(received.length!==state.length || !/^[A-Za-z0-9_-]+$/.test(received)) return null;
  if(!timingSafeEqual(Buffer.from(received),Buffer.from(state))) return null;
  if(keys.includes('code')) { const code=p.get('code')!; if(!code || code.length>1024 || /[\u0000-\u001f\u007f]/.test(code)) return null; return {kind:'code',code}; }
  if(keys.includes('error') && p.get('error')==='access_denied') return {kind:'denied'};
  return null;
}

/** One trusted local listener. It never exposes OAuth start over HTTP. */
export async function startLoopback(options:LoopbackOptions):Promise<LoopbackHandle> {
  const mode=options.mode??'probe';
  const directory=resolve(options.directory);
  await verifyPrivateDirectory(directory);
  const acceptMs=Math.min(options.acceptMs??600_000,600_000), maximumMs=Math.min(options.maximumMs??900_000,900_000);
  if(!Number.isInteger(acceptMs)||acceptMs<1||!Number.isInteger(maximumMs)||maximumMs<=acceptMs) throw new Error('LIFETIME_INVALID');
  if(mode==='real' && (!options.service || !options.cancelState || !options.authUrlPath || dirname(resolve(options.authUrlPath))!==directory)) throw new Error('CONFIG_INVALID');
  const startedAt=Date.now();
  const deadline=Math.min(startedAt+maximumMs,options.absoluteDeadlineMs??Infinity);
  const reserve=maximumMs-acceptMs;
  const acceptDeadline=Math.min(startedAt+acceptMs,mode==='real'?deadline-reserve:deadline);
  if(!Number.isFinite(deadline) || acceptDeadline<=startedAt) throw new Error('LIFETIME_INVALID');
  async function withinDeadline<T>(work:Promise<T>):Promise<{kind:'ok';value:T}|{kind:'error'}|{kind:'timeout'}> {
    // Observe the eventual result even after timeout; a timer cannot cancel I/O.
    const settled=work.then(value=>({kind:'ok' as const,value}),()=>({kind:'error' as const}));
    const remaining=deadline-Date.now();
    if(remaining<=0) return {kind:'timeout'};
    let timer:NodeJS.Timeout|undefined;
    const result=await Promise.race([
      settled,
      new Promise<{kind:'timeout'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'timeout'}),remaining);}),
    ]);
    if(timer) clearTimeout(timer);
    return result;
  }
  const sessionId=randomBytes(32).toString('base64url');
  const receiptPath=join(directory,`reach-${sessionId}.json`);
  const outcomePath=mode==='real'?join(directory,`outcome-${sessionId}.json`):undefined;
  await createPrivateFile(receiptPath,JSON.stringify({sessionId,time:new Date(startedAt).toISOString(),count:0,status:'pending'})+'\n');
  // This remains truthful if an exchange or later output write never settles.
  if(outcomePath) await createPrivateFile(outcomePath,JSON.stringify({sessionId,time:new Date(startedAt).toISOString(),status:'unknown'})+'\n');
  let state:string|undefined;
  if(mode==='real') {
    try {
      const started=await options.service!.start('slack',SLACK_LOOPBACK_TENANT,[...SCOPES]);
      if(!/^[A-Za-z0-9_-]{43}$/.test(started.state) || !started.authUrl.startsWith('https://slack.com/oauth/v2/authorize?')) throw new Error('START_INVALID');
      state=started.state;
      if(Date.now()>=acceptDeadline) throw new Error('START_EXPIRED');
      await createPrivateFile(resolve(options.authUrlPath!),started.authUrl+'\n');
    } catch {
      await withinDeadline(options.cancelState!());
      throw new Error('START_FAILED');
    }
  }
  const sockets=new Set<Socket>(); let status:SafeStatus='pending', count=0, used=false, stopping:Promise<void>|undefined, inFlight:Promise<void>|undefined;
  let receiptWrite:Promise<void>|undefined, receiptBusy=false;
  async function replace(path:string,value:unknown):Promise<void> {
    const existing=await lstat(path);
    if(!existing.isFile()||existing.isSymbolicLink()||existing.uid!==process.getuid?.()||(existing.mode&0o777)!==0o600) throw new Error('PRIVATE_FILE_INVALID');
    const temporary=join(directory,`.tmp-${randomBytes(16).toString('hex')}`);
    await createPrivateFile(temporary,JSON.stringify(value)+'\n');
    await rename(temporary,path);
    const parent=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
  function recordReach():Promise<void> {
    count++; receiptBusy=true;
    const snapshot={sessionId,time:new Date().toISOString(),count,status:'reached' as const};
    receiptWrite=(options.receiptWriter??replace)(receiptPath,snapshot).finally(()=>{receiptBusy=false;});
    return receiptWrite;
  }
  const server=createServer((req,res)=>{
    if(!validRequest(req)) { page(res,400,'Invalid request.'); return; }
    if(req.url==='/health') {
      if(Date.now()>=acceptDeadline || stopping) { page(res,410,'Unavailable.'); return; }
      if(count>=8) { page(res,429,'Unavailable.'); return; }
      if(receiptBusy) { page(res,503,'Unavailable.'); return; }
      void recordReach().then(()=>{if(!res.destroyed) {res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'",'Connection':'close'});res.end(JSON.stringify({sessionId}));}},()=>page(res,500,'Unavailable.'));
      return;
    }
    if(mode!=='real' || !req.url!.startsWith('/oauth/slack/callback')) { page(res,404,'Unavailable.'); return; }
    if(Date.now()>=acceptDeadline || used || stopping) { page(res,410,'Unavailable.'); return; }
    const parsed=query(req.url!,state!);
    if(!parsed) { page(res,400,'Invalid request.'); return; }
    used=true;
    // An accepted exchange may use the bounded PG/provider budget below. Slow
    // strangers retain the five-second socket/header deadline above.
    req.socket.setTimeout(190_000,()=>req.socket.destroy());
    if(parsed.kind==='denied') {
      inFlight=options.cancelState!().then(()=>{status='denied';page(res,200,'Denied.');},()=>{status='failed';page(res,500,'Unavailable.');});
    } else {
      inFlight=options.service!.callback(parsed.code!,state!).then(()=>{status='succeeded';page(res,200,'Complete.');},()=>{status='failed';page(res,500,'Unavailable.');});
    }
    void inFlight.then(async()=>{
      let flushTimer:NodeJS.Timeout|undefined;
      await Promise.race([responseDone(res),new Promise<void>(resolve=>{flushTimer=setTimeout(resolve,1000);})]);
      if(flushTimer) clearTimeout(flushTimer);
      await stop(status);
    });
  });
  server.maxConnections=8; server.headersTimeout=5000; server.requestTimeout=5000; server.timeout=5000; server.keepAliveTimeout=1000; server.maxHeadersCount=20;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setTimeout(5000,()=>socket.destroy());});
  server.on('clientError',(_error,socket)=>socket.destroy());
  let acceptTimer:NodeJS.Timeout|undefined, maximumTimer:NodeJS.Timeout|undefined;
  let resolveDone!:(value:string)=>void; const done=new Promise<string>(resolve=>{resolveDone=resolve;});
  async function stop(reason:SafeStatus):Promise<void> {
    if(stopping) return stopping;
    stopping=(async()=>{
      try {
        if(acceptTimer) clearTimeout(acceptTimer);
        const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
        server.closeAllConnections(); for(const socket of sockets) socket.destroy();
        if((await withinDeadline(closed)).kind!=='ok') status='unknown';
        if(inFlight) {
          if((await withinDeadline(inFlight)).kind!=='ok') status='unknown'; else reason=status;
        } else if(mode==='real' && reason!=='succeeded' && reason!=='denied') {
          if((await withinDeadline(options.cancelState!())).kind!=='ok') reason='unknown';
        }
        if(status!=='unknown') status=reason;
        if(receiptWrite && (await withinDeadline(receiptWrite)).kind!=='ok') status='unknown';
        if(outcomePath && status!=='unknown' && (await withinDeadline((options.outcomeWriter??replace)(outcomePath,{sessionId,time:new Date().toISOString(),status}))).kind!=='ok') status='unknown';
      } catch {
        status='unknown';
      } finally {
        if(maximumTimer) clearTimeout(maximumTimer);
        resolveDone(status);
      }
    })();
    return stopping;
  }
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(19101,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  } catch {
    server.close();
    if(mode==='real') {
      await withinDeadline(options.cancelState!());
      // The prewritten unknown audit remains durable without a listener.
    }
    throw new Error('LISTEN_FAILED');
  }
  server.on('error',()=>{void stop('failed');});
  acceptTimer=setTimeout(()=>{void stop('expired');},Math.max(1,acceptDeadline-Date.now()));
  maximumTimer=setTimeout(()=>{void stop('unknown');},Math.max(1,deadline-Date.now()));
  return {sessionId,receiptPath,...(outcomePath?{outcomePath}:{}),done,cancel:()=>stop('cancelled')};
}
