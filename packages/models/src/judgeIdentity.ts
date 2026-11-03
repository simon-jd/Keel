/** Existing production-tree identity, checked without cloud, credentials or model access. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function judgeIdentity():{gitSha:string;implementationSha256:string}{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const result=spawnSync('python3',['-c',"import sys,json;sys.path.insert(0,'services/bench-adapters');from provenance import execution_identity;x=execution_identity();print(json.dumps({'gitSha':x['git_sha'],'implementationSha256':x['implementation']['sha256']}))"],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',maxBuffer:4096});
 if(result.status!==0)throw new Error('CLEAN_IMPLEMENTATION_REQUIRED');
 const value=JSON.parse(result.stdout) as {gitSha:string;implementationSha256:string};
 if(!/^[0-9a-f]{40}$/.test(value.gitSha)||!/^[0-9a-f]{64}$/.test(value.implementationSha256))throw new Error('IMPLEMENTATION_IDENTITY_REQUIRED');return value;
}
