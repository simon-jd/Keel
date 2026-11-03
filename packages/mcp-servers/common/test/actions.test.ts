import { beforeAll,afterAll,expect,test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { hash } from 'runtime/actions';
import { ApprovalAuthority } from '../src/approval.js';
import { ActionJournal } from '../src/journal.js';
import { database } from './helpers.js';
const args={channel:'C123',text:'fixture-only'};
const binding={tenantId:'tenant-a',runId:'10000000-0000-4000-8000-000000000001',tool:'slack.post_message',actionKey:'a'.repeat(64),argsHash:hash(args)};
// A self-approved or mutated binding must never mint a write permit.
test('approval proof requires trusted exact approval plus guard and cannot be transplanted',async()=>{
 const key=randomBytes(32);const authority=new ApprovalAuthority(key,'http://127.0.0.1:9101/mcp');
 await expect(authority.issue(binding,args,[],async()=> 'allow')).rejects.toThrow('APPROVAL_REQUIRED');
 await expect(authority.issue(binding,args,[binding],async()=> 'deny')).rejects.toThrow('TOOL_DENIED');
 await expect(authority.issue(binding,{...args,text:'changed'},[binding],async()=> 'allow')).rejects.toThrow();
 const proof=await authority.issue(binding,args,[binding],async()=> 'allow');
 expect(authority.verify(proof,'tenant-a',binding.tool,args)).toEqual(binding);
 for(const [tenant,tool,input] of [['tenant-b',binding.tool,args],['tenant-a','github.create_issue',args],['tenant-a',binding.tool,{...args,text:'changed'}]] as const) expect(()=>authority.verify(proof,tenant,tool,input)).toThrow();
 expect(()=>authority.verify(proof+'x','tenant-a',binding.tool,args)).toThrow();
 expect(()=>new ApprovalAuthority(key,'https://wrong.example/mcp').verify(proof,'tenant-a',binding.tool,args)).toThrow();
});
let db:Awaited<ReturnType<typeof database>>;
beforeAll(async()=>{db=await database();});afterAll(async()=>{await db?.close();});
// A non-atomic reserve, plaintext payload, or lost durable state would allow duplicate writes or expose arguments.
test('durable journal claims once across connections and preserves ambiguous writes across instances',async()=>{
 const a=new ActionJournal(db.pool,db.cipher);const b=new ActionJournal(db.pool,db.cipher);
 const results=await Promise.all([a.reserve(binding,args),b.reserve(binding,args)]);
 expect(results.filter(r=>r==='acquired')).toHaveLength(1);expect(results.filter(r=>r==='unknown')).toHaveLength(1);
 expect(await b.read('tenant-a',binding.actionKey)).toMatchObject({binding,args,status:'UNKNOWN'});
 expect(await b.read('tenant-b',binding.actionKey)).toBeUndefined();
 await expect(a.reserve({...binding,argsHash:'b'.repeat(64)},args)).rejects.toThrow();
 const raw=await db.pool.query('SELECT * FROM mcp_actions');expect(JSON.stringify(raw.rows)).not.toContain('fixture-only');
 await a.succeed(binding,{id:'fixture-result'});expect(await b.reserve(binding,args)).toBe('done');
 expect(await b.read('tenant-a',binding.actionKey)).toMatchObject({status:'SUCCEEDED',result:{id:'fixture-result'}});
});

// Reusing a valid action hash under another run/tool must not read or complete the original reservation.
test('journal refuses changed run and tool bindings and enforces pool deadlines',async()=>{
 const journal=new ActionJournal(db.pool,db.cipher);const b={...binding,actionKey:'c'.repeat(64)};await journal.reserve(b,args);
 for(const changed of [{...b,runId:'20000000-0000-4000-8000-000000000002'},{...b,tool:'github.create_issue'}])await expect(journal.reserve(changed,args)).rejects.toThrow('BINDING_MISMATCH');
 const {Pool}=await import('pg');const pool=new Pool({connectionString:db.connectionString});try{expect(()=>new ActionJournal(pool,db.cipher)).toThrow('STORE_CONFIG_INVALID');}finally{await pool.end();}
});
