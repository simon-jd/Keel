import { externalDatabase } from '../../../runtime/test/externalDatabase.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { TokenCipher, PostgresTokenStore, OAuthService, slack } from 'oauth';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
export async function fixture(handler: (req: IncomingMessage, res: ServerResponse, raw: Buffer) => Promise<void> | void) {
 const failures: unknown[] = [];
 const server=createServer(async(req,res)=> {try {const chunks: Buffer[]=[];for await(const c of req) chunks.push(Buffer.from(c));res.setHeader('Content-Type','application/json');await handler(req,res,Buffer.concat(chunks));}catch(e){failures.push(e);res.statusCode=500;res.end('{}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening'); const a=server.address();if(!a||typeof a==='string')throw Error();
 return { origin:`http://127.0.0.1:${a.port}`, failures, async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
export const keys=generateKeyPairSync('rsa',{modulusLength:2048});
export function jwt(resource: string, overrides: Record<string,unknown> = {}, privateKey=keys.privateKey) {
 const now=Math.floor(Date.now()/1000);const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'at+jwt'})).toString('base64url');
 const p=Buffer.from(JSON.stringify({iss:'https://fixture-as.example',aud:resource,sub:'subject-a',client_id:'fixture-runtime',scope:'mcp',iat:now,exp:now+300,...overrides})).toString('base64url');
 return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;
}
export async function database() {
 const container=await externalDatabase() ?? await new PostgreSqlContainer('pgvector/pgvector:0.8.1-pg17').withLabels({project:'keel',purpose:'mcp-tests'}).withResourcesQuota({memory:512*1024*1024,cpu:1}).start();
 const pool=new Pool({connectionString:container.getConnectionUri(),connectionTimeoutMillis:3000});
 const migrationDir=new URL('../../../db/migrations/',import.meta.url);
 for(const name of (await readdir(migrationDir)).filter(n=>n.endsWith('.up.sql')).sort()) await pool.query(await readFile(new URL(name,migrationDir),'utf8'));
 const dir=await mkdtemp('/tmp/keel-mcp-');await writeFile(`${dir}/key`,randomBytes(32),{mode:0o600});const cipher=await TokenCipher.fromKeyFile(`${dir}/key`);
 return {pool,cipher,connectionString:container.getConnectionUri(),async close(){await pool.end();await container.stop();await rm(dir,{recursive:true,force:true});}};
}
export function oauth(db: Awaited<ReturnType<typeof database>>, origin: string) {
 return new OAuthService(new PostgresTokenStore(db.pool,db.cipher,{timeoutMs:1000}),[slack({clientId:'fixture-slack',redirectUri:'http://127.0.0.1/callback',timeoutMs:500,endpoints:{authorize:origin+'/authorize',token:origin+'/token',revoke:origin+'/revoke'}})]);
}
export async function consent(service: OAuthService, tenant='tenant-a') {const {state}=await service.start('slack',tenant,['chat:write','search:read']);await service.callback('fixture-code',state);}
export async function client(url: string, token=jwt(url)) {
 const c=new Client({name:'fixture-client',version:'1.0.0'});
 await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return c;
}
export const authConfig = { issuer:'https://fixture-as.example', publicKey:keys.publicKey, subjects:{'subject-a':'tenant-a','subject-b':'tenant-b'} };
