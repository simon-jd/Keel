import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { TokenCipher } from 'oauth';
import { ActionJournal } from './journal.js';
import type { ServerOptions } from './server.js';
export async function readSecretFile(path:string):Promise<Buffer>{
 try{const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.uid!==process.getuid?.()||stat.size<1||stat.size>65536)throw Error();const bytes=await file.readFile();if(bytes.length>65536)throw Error();return bytes;}finally{await file.close();}}
 catch{throw Error('CONFIG_INVALID');}
}
const configSchema=z.object({port:z.number().int().min(0).max(65535).optional(),resource:z.string().optional(),databaseUrl:z.string().min(1),encryptionKeyFile:z.string().min(1),approvalKeyFile:z.string().min(1),auth:z.object({issuer:z.string().url(),publicKeyFile:z.string().min(1),subjects:z.record(z.string().min(1),z.string().min(1))}).strict(),provider:z.unknown()}).strict();
/** Secrets and routing live in an owner-only deployment file, never model arguments or repository examples. */
export async function loadDeployment(path:string,defaultPort:number):Promise<{pool:Pool;cipher:TokenCipher;base:Omit<ServerOptions,'name'|'tools'|'webhook'>;provider:unknown}> {
 try{
  const config=configSchema.parse(JSON.parse((await readSecretFile(path)).toString()));const cipher=await TokenCipher.fromKeyFile(config.encryptionKeyFile);
  const approvalKey=await readSecretFile(config.approvalKeyFile);if(approvalKey.length!==32)throw Error();
  const publicKey=createPublicKey(await readSecretFile(config.auth.publicKeyFile));
  const pool=new Pool({connectionString:config.databaseUrl,max:4,connectionTimeoutMillis:3000});pool.on('error',()=>{});
  return {pool,cipher,provider:config.provider,base:{port:config.port??defaultPort,...(config.resource?{resource:config.resource}:{}),auth:{issuer:config.auth.issuer,publicKey,subjects:config.auth.subjects},approvalKey,journal:new ActionJournal(pool,cipher,3000)}};
 }catch{throw Error('CONFIG_INVALID');}
}
export function installShutdown(close:()=>Promise<void>):void {
 let closing=false;const stop=()=>{if(closing)return;closing=true;void close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
