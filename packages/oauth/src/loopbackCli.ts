/** Trusted local entry point. No HTTP OAuth-start endpoint and no credential output. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { TokenCipher } from './crypto.js';
import { OAuthService } from './flow.js';
import { startLoopback, SLACK_LOOPBACK_REDIRECT, SLACK_LOOPBACK_TENANT, verifyPrivateDirectory } from './loopback.js';
import { slack } from './providers/slack.js';
import { PostgresTokenStore } from './store.js';

type PrivateConfig={clientId:string;connectionString:string;keyFile:string};
export async function readPrivateConfig(path:string,directory:string):Promise<PrivateConfig> {
  const dir=resolve(directory), configPath=resolve(path);
  await verifyPrivateDirectory(dir);
  if(dirname(configPath)!==dir) throw new Error('CONFIG_INVALID');
  const file=await open(configPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:string;
  try {
    const s=await file.stat();
    if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size<2||s.size>4096) throw new Error('CONFIG_INVALID');
    raw=await file.readFile('utf8');
  } finally { await file.close(); }
  let data:unknown;
  try { data=JSON.parse(raw); } catch { throw new Error('CONFIG_INVALID'); }
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!=='clientId,connectionString,keyFile') throw new Error('CONFIG_INVALID');
  const item=data as Record<string,unknown>;
  if(typeof item.clientId!=='string'||!item.clientId||item.clientId.length>200||/^A[0-9A-Z]{8,}$/.test(item.clientId)||/\s/.test(item.clientId)||typeof item.connectionString!=='string'||item.connectionString.length>2048||typeof item.keyFile!=='string'||dirname(resolve(item.keyFile))!==dir) throw new Error('CONFIG_INVALID');
  let pg:URL;
  try { pg=new URL(item.connectionString); } catch { throw new Error('CONFIG_INVALID'); }
  // pg-connection-string lets URL query fields override the authority host and
  // request extra certificate/key file reads. This narrow CLI needs neither.
  if(!['postgres:','postgresql:'].includes(pg.protocol)||!['localhost','127.0.0.1'].includes(pg.hostname)||pg.search||pg.hash) throw new Error('CONFIG_INVALID');
  return {clientId:item.clientId,connectionString:item.connectionString,keyFile:item.keyFile};
}

export async function runLoopbackCli(args:string[],absoluteDeadlineMs=Date.now()+900_000):Promise<void> {
  // Deliberately no flags for scopes, tenant, port, redirect, provider endpoints or lifetimes.
  if(![2,3].includes(args.length)||args[0]!=='--directory'||(args.length===3&&args[2]!=='--real')) throw new Error('USAGE');
  const directory=resolve(args[1]!);
  await verifyPrivateDirectory(directory);
  const configPath=join(directory,'config.json');
  // The probe is the default and does not even inspect a configuration or key file.
  const mode=args[2]==='--real'?'real':'probe';
  if(mode==='probe') {
    const handle=await startLoopback({directory,absoluteDeadlineMs});
    const onSignal=()=>{void handle.cancel();}; process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
    console.log(`Probe listening on 127.0.0.1:19101; receipt ${handle.receiptPath}`);
    await handle.done; return;
  }
  const config=await readPrivateConfig(configPath,directory);
  const cipher=await TokenCipher.fromKeyFile(config.keyFile);
  const pool=new Pool({connectionString:config.connectionString,ssl:false,max:1,connectionTimeoutMillis:15000,idleTimeoutMillis:1000});
  pool.on('error',()=>{});
  let unresolved=false;
  try {
    const store=new PostgresTokenStore(pool,cipher,{timeoutMs:15000});
    const service=new OAuthService(store,[slack({clientId:config.clientId,redirectUri:SLACK_LOOPBACK_REDIRECT,timeoutMs:10000,tokenKind:'user'})],{stateTtlMs:600000});
    const handle=await startLoopback({mode:'real',directory,service,authUrlPath:join(directory,'auth-url'),absoluteDeadlineMs,cancelState:()=>store.withLock(SLACK_LOOPBACK_TENANT,'slack',client=>store.cancelStates(client,SLACK_LOOPBACK_TENANT,'slack'))});
    const onSignal=()=>{void handle.cancel();}; process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
    console.log(`Callback listening on 127.0.0.1:19101; private outcome ${handle.outcomePath}`);
    const outcome=await handle.done;
    console.log(`Callback ${outcome}.`);
    if(['unknown','failed','expired'].includes(outcome)) process.exitCode=2;
    unresolved=outcome==='unknown';
  } finally { if(!unresolved) await pool.end(); }
}

/** The direct CLI's absolute watchdog spans config/receipt fsyncs, OAuth work,
 * outcome fsyncs and pg Pool.end. Termination does not revoke a remote grant. */
export async function withCliWatchdog<T>(work:(absoluteDeadlineMs:number)=>Promise<T>, terminate:()=>void, maximumMs=900_000):Promise<T> {
  const absoluteDeadlineMs=Date.now()+maximumMs;
  const timer=setTimeout(terminate,maximumMs);
  try { return await work(absoluteDeadlineMs); } finally { clearTimeout(timer); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  withCliWatchdog(deadline=>runLoopbackCli(process.argv.slice(2),deadline),()=>process.exit(2)).then(()=>{if(process.exitCode===2) process.exit(2);}).catch(()=>{console.error('Loopback failed. Inspect owner-only outcome files; retain config, key and database for grant review.');process.exitCode=1;});
}
