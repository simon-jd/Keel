import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defineTool,type Tool } from 'runtime/tools';
import { hash } from 'runtime/actions';
import type { Approval } from 'runtime/types';
import type { ToolSpec } from './server.js';
import type { ApprovalAuthority,Guard } from './approval.js';
import { boundedBody,trustedUrl } from './http.js';
export interface BridgeOptions {tenantId:string;service:string;spec:Pick<ToolSpec,'name'|'schema'|'write'>;url:string;token:()=>Promise<string>;authority:ApprovalAuthority;approvals:()=>readonly Approval[];guard?:Guard}
/** Construct only in the trusted runtime host. Models receive spec.schema, never credentials/permits. */
export function createRuntimeTool(options:BridgeOptions):Tool {
 const url=trustedUrl(options.url);const name=`${options.service}.${options.spec.name}`;
 return defineTool({name,schema:options.spec.schema,sideEffect:options.spec.write,
  async run(raw,ctx){
   const args=options.spec.schema.parse(raw);
   if(ctx.tenantId!==options.tenantId||ctx.tool!==name||ctx.argsHash!==hash(args))throw Error('BINDING_MISMATCH');ctx.signal.throwIfAborted();
   const binding:Approval={tenantId:ctx.tenantId,runId:ctx.runId,tool:ctx.tool,actionKey:ctx.actionKey,argsHash:ctx.argsHash};
   const proof=options.spec.write?await options.authority.issue(binding,args,options.approvals(),options.guard,ctx.policyAuthorization):undefined;
   const client=new Client({name:'keel-runtime',version:'1.0.0'});
   try{
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${await options.token()}`},signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(12000)])}}));
    const result=await client.callTool({name:options.spec.name,arguments:args,...(proof?{_meta:{'keel/approval':proof}}:{})},{signal:ctx.signal,timeout:12000,maxTotalTimeout:12000});
    if(result.isError)throw Error();const content=result.content[0];if(content?.type!=='text')throw Error();return JSON.parse(content.text) as unknown;
   }catch{throw Error('MCP_CALL_FAILED');}finally{await client.close().catch(()=>{});}
  },
  async lookup(actionKey){
   try{
    const response=await fetch(new URL('/actions/lookup',url),{method:'POST',headers:{Authorization:`Bearer ${await options.token()}`,'Content-Type':'application/json'},body:JSON.stringify({actionKey,tool:name}),redirect:'error',signal:AbortSignal.timeout(12000)});
    const data=JSON.parse((await boundedBody(response,8192)).toString()) as {status?:unknown};
    if(!response.ok||(data.status!=='done'&&data.status!=='absent'))throw Error();return data.status;
   }catch{throw Error('ACTION_UNKNOWN');}
  },
 });
}
