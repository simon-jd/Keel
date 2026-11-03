import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OAuthService,PostgresTokenStore,slack } from 'oauth';
import { startServer } from 'mcp-common/server';
import { loadDeployment,readSecretFile,installShutdown } from 'mcp-common/config';
import { slackTools,verifySlackWebhook } from './index.js';
const schema=z.object({clientId:z.string().min(1),redirectUri:z.string().url(),clientSecretFile:z.string().optional(),signingSecretFile:z.string().min(1)}).strict();
export async function launchSlack(path:string){
 const deployment=await loadDeployment(path,9101);
 try{const config=schema.parse(deployment.provider);const signingSecret=(await readSecretFile(config.signingSecretFile)).toString();
  const service=new OAuthService(new PostgresTokenStore(deployment.pool,deployment.cipher,{timeoutMs:15000}),[slack({clientId:config.clientId,redirectUri:config.redirectUri,...(config.clientSecretFile?{clientSecret:(await readSecretFile(config.clientSecretFile)).toString()}:{})})]);
  const server=await startServer({...deployment.base,name:'slack',tools:slackTools(service),webhook:(raw,headers)=>verifySlackWebhook(raw,headers.get('x-slack-request-timestamp')??'',headers.get('x-slack-signature')??'',signingSecret)});
  return {...server,async close(){await server.close();await deployment.pool.end();}};
 }catch{await deployment.pool.end();throw Error('MCP_START_FAILED');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const path=process.argv[2];if(!path)throw Error();const service=await launchSlack(path);installShutdown(()=>service.close());console.log(`Slack MCP listening at ${service.url}`);}catch{console.error('MCP_START_FAILED');process.exitCode=1;}}
