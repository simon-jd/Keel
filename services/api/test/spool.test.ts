import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTracing } from 'tracing/exporter';
import { withSpan } from 'tracing/span';
import { createSpanSpool } from '../src/spool.js';
test('spools real IDs and timestamps with privacy projection and a hard byte cap',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'keel-span-'));const path=join(dir,'spans.jsonl');
 const tracer=configureTracing({exporter:createSpanSpool(path,2000)});
 try{
  await withSpan('llm',{'gen_ai.request.model':'Qwen/Qwen3-8B','secret':'never-export-this','keel.run_id':'123e4567-e89b-12d3-a456-426614174000'},async()=>{});
  await tracer.forceFlush();
  const raw=readFileSync(path,'utf8');const span=JSON.parse(raw);
  expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);expect(span.startTime[0]).toBeGreaterThan(1700000000);expect(raw).not.toContain('never-export-this');
  for(let i=0;i<10;i++)await withSpan('llm',{},async()=>{});
  expect(readFileSync(path).length).toBeLessThanOrEqual(2000);
 }finally{await tracer.shutdown();rmSync(dir,{recursive:true});}
});
