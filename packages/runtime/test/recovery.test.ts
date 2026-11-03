import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../src/loop.js';
import { defineTool } from '../src/tools.js';
import { PostgresStore } from '../src/store.js';
import { canonical, actionKey } from '../src/actions.js';
import { call, database, scripted, task } from './helpers.js';
import type { Approval } from '../src/types.js';
let db: Awaited<ReturnType<typeof database>>;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db?.client.end(); await db?.container.stop(); });

// An actual kill between external commit and local success must reconcile, never execute twice.
test('resumeAfterCrashDoesNotRepeatSideEffects', async () => {
  const id = randomUUID();
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./worker.ts', import.meta.url).pathname], {
    env: { ...process.env, TEST_DATABASE_URL: db.url, TEST_RUN_ID: id }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let errors = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.includes('EFFECT_COMMITTED')) child.kill('SIGKILL'); });
  child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [, signal] = await once(child, 'exit');
  clearTimeout(timeout);
  expect(output).toContain('EFFECT_COMMITTED');
  expect(errors).toBe(''); expect(signal).toBe('SIGKILL');
  const pending = (await db.client.query('SELECT * FROM actions WHERE run_id=$1', [id])).rows[0];
  expect(pending.status).toBe('PENDING');
  let lookupSawUnknown = false;
  const tool = defineTool({ name: 'counter.write', schema: z.object({ value: z.number() }), sideEffect: true,
    async run(_args, ctx) { await db.client.query('UPDATE effect_counter SET n=n+1 WHERE action_key=$1', [ctx.actionKey]); return 2; },
    async lookup(key) {
      lookupSawUnknown = (await db.client.query('SELECT status FROM actions WHERE action_key=$1', [key])).rows[0].status === 'UNKNOWN';
      return (await db.client.query('SELECT n FROM effect_counter WHERE action_key=$1', [key])).rowCount ? 'done' : 'absent';
    },
  });
  const waiting = await runAgent(id, task, { store: new PostgresStore(db.url), model: scripted([{ text: 'must not run' }]), tools: [tool] });
  expect(waiting.status).toBe('NEEDS_APPROVAL');
  expect((await db.client.query('SELECT status FROM actions WHERE run_id=$1', [id])).rows[0].status).toBe('UNKNOWN');
  const approval: Approval = { tenantId: task.tenantId, runId: id, tool: tool.name, actionKey: pending.action_key, argsHash: pending.args_hash };
  const result = await runAgent(id, task, { store: new PostgresStore(db.url), model: scripted([{ text: 'recovered' }], request => {
    expect(request.messages.find(m => m.role === 'assistant')?.toolCalls?.[0]?.id).toBe('call-1');
    expect(request.messages.find(m => m.role === 'tool')?.toolCallId).toBe('call-1');
  }), tools: [tool], approvals: [approval] });
  expect(result).toMatchObject({ status: 'DONE', budget: { modelCalls: 2, toolCalls: 1 } });
  expect(lookupSawUnknown).toBe(true);
  expect((await db.client.query('SELECT n FROM effect_counter WHERE action_key=$1', [pending.action_key])).rows[0].n).toBe(1);
});
// Throwing after effect commit is ambiguous, including when a provider lookup itself fails.
test.each(['missing', 'throws', 'done', 'absent'] as const)('effect then exception: %s lookup', async mode => {
  const id = randomUUID(); let executions = 0;
  const tool = defineTool({ name: 'counter.write', schema: z.object({ value: z.number() }), sideEffect: true,
    async run(_args, ctx) { executions++; await db.client.query('INSERT INTO effect_counter VALUES ($1,1) ON CONFLICT (action_key) DO UPDATE SET n=effect_counter.n+1', [ctx.actionKey]); throw new Error('secret result'); },
    ...(mode === 'missing' ? {} : { async lookup() { if (mode === 'throws') throw new Error('secret'); return mode; } }),
  });
  const base = { store: db.store, model: scripted([call({ value: 1 }, tool.name), { text: 'done' }]), tools: [tool] };
  const waiting = await runAgent(id, task, base);
  const approved = { ...base, approvals: [waiting.approval!] };
  expect(await runAgent(id, task, approved)).toMatchObject({ status: 'NEEDS_APPROVAL', errorCode: 'ACTION_UNKNOWN' });
  const result = await runAgent(id, task, { ...approved, store: new PostgresStore(db.url) });
  expect(result.status).toBe(mode === 'done' ? 'DONE' : 'NEEDS_APPROVAL');
  expect(executions).toBe(mode === 'absent' ? 2 : 1);
  expect((await db.client.query('SELECT status FROM actions WHERE run_id=$1', [id])).rows[0].status).toBe(mode === 'done' ? 'SUCCEEDED' : 'UNKNOWN');
});
// Restarting a waiting run must not reset spent model calls or tool cap.
test('durable budget survives store replacement and approval resume', async () => {
  const id = randomUUID();
  const tool = defineTool({ name: 'counter.write', schema: z.object({ value: z.number() }), sideEffect: true, async run() { return 'ok'; } });
  const base = { store: db.store, model: scripted([call({ value: 1 }, tool.name)]), tools: [tool], budget: { modelCalls: 1, toolCalls: 1 } };
  const waiting = await runAgent(id, task, base);
  const result = await runAgent(id, task, { ...base, store: new PostgresStore(db.url), approvals: [waiting.approval!] });
  expect(result).toMatchObject({ status: 'BUDGET_EXCEEDED', budget: { modelCalls: 1, toolCalls: 1 } });
});
// Stable parsed JSON identity must reject unsafe non-JSON data and disambiguate delimiter-containing fields.
test('canonical action identity is stable and collision-safe', () => {
  expect(canonical({ b: 2, a: [true, null] })).toBe('{"a":[true,null],"b":2}');
  expect(actionKey('a|b', 1, 'c', {})).not.toBe(actionKey('a', 1, 'b|c', {}));
  expect(actionKey('run', 1, 'read', { a: 1, b: 2 })).toBe(actionKey('run', 1, 'read', { b: 2, a: 1 }));
  for (const input of [undefined, NaN, Infinity, { a: undefined }, new Date(), [undefined], BigInt(1)]) expect(() => canonical(input)).toThrow();
});
// Loss of the caller after a final response commit must not buy another model invocation on resume.
test('final response checkpoint is terminal even when caller loses the commit acknowledgement', async () => {
  const id = randomUUID();
  class LostAcknowledgementStore extends PostgresStore {
    override async withRun<T>(runId: string, work: (session: import('../src/store.js').RunSession) => Promise<T>): Promise<T | undefined> {
      return super.withRun(runId, session => {
        const save = session.save.bind(session);
        session.save = async (...args: Parameters<typeof save>) => {
          await save(...args);
          if (args[2]?.kind === 'model' && args[2].status === 'SUCCEEDED') throw new Error('lost acknowledgement');
        };
        return work(session);
      });
    }
  }
  await runAgent(id, task, { store: new LostAcknowledgementStore(db.url), model: scripted([{ text: 'committed answer' }]), tools: [] });
  const result = await runAgent(id, task, { store: new PostgresStore(db.url), model: scripted([{ text: 'duplicate answer' }]), tools: [] });
  expect(result).toMatchObject({ status: 'DONE', output: 'committed answer', budget: { modelCalls: 1, toolCalls: 0 } });
});
