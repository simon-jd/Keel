import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,fstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const state=vi.hoisted(()=>({spanFd:-1,spanCreated:false,failParentOnce:false,failFileOnce:false,beforeClaim:false,operations:[] as {operation:string;fd:number;kind?:string;path?:string}[]}));
const binding=vi.hoisted(()=>({quote_id:'synthetic-spool-only',quoteHash:'a'.repeat(64)}));
vi.mock('node:fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs')>();
 return {...actual,
  openSync:(...args:Parameters<typeof actual.openSync>)=>{const fd=actual.openSync(...args),path=String(args[0]);state.operations.push({operation:'open',fd,path});if(path.endsWith('safe-spans.jsonl')){state.spanCreated=true;state.spanFd=fd;}return fd;},
  fsyncSync:(fd:number)=>{const kind=actual.fstatSync(fd).isDirectory()?'directory':'file';state.operations.push({operation:'sync',fd,kind});if(state.spanCreated&&state.failFileOnce&&kind==='file'){state.failFileOnce=false;throw new Error('synthetic file fsync failure');}if(state.spanCreated&&state.failParentOnce&&kind==='directory'){state.failParentOnce=false;throw new Error('synthetic parent fsync failure');}actual.fsyncSync(fd);},
  closeSync:(fd:number)=>{state.operations.push({operation:'close',fd});actual.closeSync(fd);}
 };
});
vi.mock('../../../packages/models/src/azureJudgeProfile.js',async importOriginal=>({...await importOriginal<typeof import('../../../packages/models/src/azureJudgeProfile.js')>(),prepareJudgeProfile:()=>({binding})}));
vi.mock('../../../packages/models/src/azureCommercial.js',async importOriginal=>({...await importOriginal<typeof import('../../../packages/models/src/azureCommercial.js')>(),createAzureJudgeRoute:vi.fn(async()=>{
 const open=state.operations.findIndex(x=>x.operation==='open'&&x.fd===state.spanFd&&x.path?.endsWith('safe-spans.jsonl'));
 state.beforeClaim=state.operations.slice(open+1).some(x=>x.operation==='sync'&&x.kind==='directory');
 throw new Error('synthetic admission forbidden');
})}));
import {createAzureJudgeRoute} from '../../../packages/models/src/azureCommercial.js';
import {main} from '../src/routes/commercialJudge.js';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'keel-durable-spool-')),config=join(directory,'config.json'),output=join(directory,'report.json'),spans=join(directory,'safe-spans.jsonl');
 writeFileSync(config,JSON.stringify({ledger:join(directory,'synthetic-ledger'),reservationId:'synthetic-no-admission',keyFile:join(directory,'synthetic-no-key'),binding,inputPerMillion:'0.4',outputPerMillion:'1.6'}),{mode:0o600});
 vi.stubEnv('KEEL_SPAN_FILE',spans);vi.stubGlobal('fetch',()=>{throw new Error('NETWORK_FORBIDDEN');});return {directory,config,output,spans};
}
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.mocked(createAzureJudgeRoute).mockClear();state.operations=[];state.spanFd=-1;state.spanCreated=false;state.failParentOnce=false;state.failFileOnce=false;state.beforeClaim=false;});
test('durable spool parent is fsynced before the CLI can claim a route',async()=>{
 const f=fixture();try{
  await expect(main(['run',f.config,f.output])).rejects.toThrow('COMMERCIAL_RUN_FAILED_PRIVATE_EVIDENCE_RETAINED');
  expect(createAzureJudgeRoute).toHaveBeenCalledTimes(1);expect(state.beforeClaim).toBe(true);
  expect(readFileSync(f.spans).byteLength).toBe(0);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('parent-fsync creation failure closes owned descriptors, retains the empty file and never admits',async()=>{
 const f=fixture();state.failParentOnce=true;try{
  await expect(main(['run',f.config,f.output])).rejects.toThrow('COMMERCIAL_RUN_FAILED_PRIVATE_EVIDENCE_RETAINED');
  expect(createAzureJudgeRoute).not.toHaveBeenCalled();expect(state.spanFd).toBeGreaterThanOrEqual(0);expect(()=>fstatSync(state.spanFd)).toThrow();
  const spanOpen=state.operations.findIndex(x=>x.operation==='open'&&x.fd===state.spanFd&&x.path===f.spans);
  const parentSync=state.operations.slice(spanOpen+1).find(x=>x.operation==='sync'&&x.kind==='directory');expect(parentSync).toBeDefined();expect(state.operations).toContainEqual({operation:'close',fd:parentSync!.fd});
  expect(readFileSync(f.spans).byteLength).toBe(0);expect(JSON.parse(readFileSync(f.output+'.pending','utf8'))).toMatchObject({status:'failed; no resume',events:[]});
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('initial durable file-fsync failure closes its file before any parent sync or admission',async()=>{
 const f=fixture();state.failFileOnce=true;try{
  await expect(main(['run',f.config,f.output])).rejects.toThrow('COMMERCIAL_RUN_FAILED_PRIVATE_EVIDENCE_RETAINED');
  expect(createAzureJudgeRoute).not.toHaveBeenCalled();expect(state.spanFd).toBeGreaterThanOrEqual(0);expect(()=>fstatSync(state.spanFd)).toThrow();expect(readFileSync(f.spans).byteLength).toBe(0);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
