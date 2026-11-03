import { pathToFileURL } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import { startServer } from 'mcp-common/server';
import { loadDeployment,readSecretFile,installShutdown } from 'mcp-common/config';
import { githubTools,verifyGithubWebhook,repoSchema } from './index.js';
const schema=z.object({appId:z.string().regex(/^\d+$/),privateKeyFile:z.string().min(1),webhookSecretFile:z.string().min(1),tenants:z.record(z.string(),z.object({installationId:z.number().int().positive(),repositories:z.array(repoSchema).min(1)}).strict())}).strict();
export async function launchGithub(path:string){
 const deployment=await loadDeployment(path,9102);
 try{const config=schema.parse(deployment.provider);const secret=(await readSecretFile(config.webhookSecretFile)).toString();const privateKey=createPrivateKey(await readSecretFile(config.privateKeyFile));
  const server=await startServer({...deployment.base,name:'github',tools:githubTools({appId:config.appId,privateKey,tenants:config.tenants}),webhook:(raw,headers)=>verifyGithubWebhook(raw,headers.get('x-hub-signature-256')??'',secret)});
  return {...server,async close(){await server.close();await deployment.pool.end();}};
 }catch{await deployment.pool.end();throw Error('MCP_START_FAILED');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const path=process.argv[2];if(!path)throw Error();const service=await launchGithub(path);installShutdown(()=>service.close());console.log(`GitHub MCP listening at ${service.url}`);}catch{console.error('MCP_START_FAILED');process.exitCode=1;}}
