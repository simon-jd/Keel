import { afterAll,beforeAll,expect,test } from 'vitest';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { database,keys } from '../../common/test/helpers.js';
import { launchGithub } from '../src/main.js';
let db:Awaited<ReturnType<typeof database>>;let dir:string;
beforeAll(async()=>{db=await database();dir=await mkdtemp('/tmp/keel-github-launch-');});afterAll(async()=>{await db?.close();await rm(dir,{recursive:true,force:true});});
// Miswiring installation identity and its PEM key would leave only test factories usable.
test('launches GitHub resource server from owner-only installation config',async()=>{
 for(const [file,bytes]of [['key',randomBytes(32)],['approval',randomBytes(32)],['public',keys.publicKey.export({type:'spki',format:'pem'})],['private',keys.privateKey.export({type:'pkcs8',format:'pem'})],['signing','fixture-signing']] as const)await writeFile(`${dir}/${file}`,bytes,{mode:0o600});
 const path=dir+'/config.json';await writeFile(path,JSON.stringify({port:0,databaseUrl:db.connectionString,encryptionKeyFile:dir+'/key',approvalKeyFile:dir+'/approval',auth:{issuer:'https://fixture-as.example',publicKeyFile:dir+'/public',subjects:{'subject-a':'tenant-a'}},provider:{appId:'42',privateKeyFile:dir+'/private',webhookSecretFile:dir+'/signing',tenants:{'tenant-a':{installationId:123,repositories:['fixture/repo']}}}}),{mode:0o600});
 const service=await launchGithub(path);try{expect((await fetch(service.origin+'/.well-known/oauth-protected-resource/mcp')).status).toBe(200);expect((await fetch(service.url)).status).toBe(401);}finally{await service.close();}
});
