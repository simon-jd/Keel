import type { Pool, QueryResultRow } from 'pg';
import type { TokenCipher } from 'oauth';
import { acquire } from 'oauth/session';
import { canonical, hash } from 'runtime/actions';
import type { Approval } from 'runtime/types';
import { bindingSchema } from './approval.js';
export type AuthorizationSource = {source:'human'}|{source:'policy';policyHash:string};
export interface ActionRecord {authorization?:AuthorizationSource;binding:Approval;args:unknown;status:'UNKNOWN'|'SUCCEEDED';result?:unknown;evidence?:unknown}
/** A durable UNKNOWN reservation is committed before dispatch. It is never automatically deleted/retried. */
export class ActionJournal {
  constructor(private readonly pool:Pool,private readonly cipher:TokenCipher,private readonly timeoutMs=3000) {
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000||!Number.isInteger(pool.options.connectionTimeoutMillis)||pool.options.connectionTimeoutMillis!<1||pool.options.connectionTimeoutMillis!>15000)throw Error('STORE_CONFIG_INVALID');
  }
  private async query<T extends QueryResultRow>(sql:string,values:unknown[]) {
    const session=await acquire(this.pool,this.timeoutMs);
    try {await session.query(`SET statement_timeout = ${this.timeoutMs}`);return await session.query<T>(sql,values);}
    catch{throw Error('STORE_ERROR');}
    finally{await session.release();}
  }
  async reserve(raw:Approval,args:unknown,evidence:unknown=null,authorization:AuthorizationSource={source:'human'}):Promise<'acquired'|'unknown'|'done'> {
    const b=bindingSchema.parse(raw);if(hash(args)!==b.argsHash)throw Error('BINDING_MISMATCH');
    const payload=this.cipher.encrypt(canonical({args,evidence,authorization}),['mcp',b.tenantId,b.actionKey,b.argsHash,'args']);
    const inserted=await this.query('INSERT INTO mcp_actions(tenant_id,action_key,run_id,tool,args_hash,status,payload) VALUES($1,$2,$3,$4,$5,\'UNKNOWN\',$6) ON CONFLICT DO NOTHING RETURNING action_key',[b.tenantId,b.actionKey,b.runId,b.tool,b.argsHash,payload]);
    if(inserted.rows.length)return 'acquired';
    const existing=await this.read(b.tenantId,b.actionKey);
    if(!existing||canonical(existing.binding)!==canonical(b))throw Error('BINDING_MISMATCH');
    return existing.status==='SUCCEEDED'?'done':'unknown';
  }
  async read(tenant:string,key:string):Promise<ActionRecord|undefined> {
    const result=await this.query<{tenant_id:string;action_key:string;run_id:string;tool:string;args_hash:string;status:'UNKNOWN'|'SUCCEEDED';payload:Buffer;result:Buffer|null}>('SELECT * FROM mcp_actions WHERE tenant_id=$1 AND action_key=$2',[tenant,key]);
    const row=result.rows[0];if(!row)return undefined;
    const binding={tenantId:row.tenant_id,actionKey:row.action_key,runId:row.run_id,tool:row.tool,argsHash:row.args_hash};
    const payload=JSON.parse(this.cipher.decrypt(row.payload,['mcp',tenant,key,row.args_hash,'args'])) as {args:unknown;evidence:unknown;authorization?:AuthorizationSource};
    return {binding,...(payload.authorization?{authorization:payload.authorization}:{}),status:row.status,args:payload.args,evidence:payload.evidence,...(row.result?{result:JSON.parse(this.cipher.decrypt(row.result,['mcp',tenant,key,row.args_hash,'result']))}:{})};
  }
  async succeed(b:Approval,result:unknown):Promise<void> {
    const encrypted=this.cipher.encrypt(canonical(result),['mcp',b.tenantId,b.actionKey,b.argsHash,'result']);
    const updated=await this.query('UPDATE mcp_actions SET status=\'SUCCEEDED\',result=$6,updated_at=now() WHERE tenant_id=$1 AND action_key=$2 AND run_id=$3 AND tool=$4 AND args_hash=$5 RETURNING action_key',[b.tenantId,b.actionKey,b.runId,b.tool,b.argsHash,encrypted]);
    if(!updated.rows.length)throw Error('BINDING_MISMATCH');
  }
}
