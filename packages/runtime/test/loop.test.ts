import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../src/loop.js';
import { defineTool } from '../src/tools.js';
import { PostgresStore } from '../src/store.js';
import { call, database, scripted, task } from './helpers.js';
import type { Approval, Deps } from '../src/types.js';

let db: Awaited<ReturnType<typeof database>>;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db?.client.end(); await db?.container.stop(); });
const schema = z.object({ value: z.number() });
function deps(chunks = [call()], extra: Partial<Deps> = {}): Deps {
  return { store: db.store, model: scripted(chunks), tools: [defineTool({ name: 'counter.read', schema, sideEffect: false, async run({ value }) { return value; } })], ...extra };
}
// Missing schema/batch validation would execute the valid sibling and accept the malformed call.
test.each(['type', 'json'] as const)('rejectsMalformedToolArgs: %s', async (kind) => {
  let executions = 0;
  const bad = kind === 'type' ? call({ value: 'bad' }) : { invalidToolCalls: [{ id: 'broken', name: 'counter.read', error: 'malformed_json' as const }] };
  const id = randomUUID();
  const result = await runAgent(id, task, deps([{ ...bad, toolCalls: [...(bad.toolCalls ?? []), { id: 'valid', name: 'counter.read', args: { value: 2 } }] }], {
    tools: [defineTool({ name: 'counter.read', schema, sideEffect: false, async run() { executions++; } })],
  }));
  expect(result).toMatchObject({ status: 'FAILED', errorCode: 'INVALID_TOOL_ARGS' });
  expect(result.budget.modelCalls).toBe(3);
  expect(executions).toBe(0);
  const resumed = await runAgent(id, task, deps([{ text: 'must not change terminal state' }]));
  expect(resumed).toEqual(result);
});
// Missing reservation/default cap would execute nine models or seventeen tools.
test.each(['model', 'tool'] as const)('budgetStopsRun: %s', async (kind) => {
  let effects = 0;
  const toolCalls = Array.from({ length: kind === 'tool' ? 3 : 1 }, (_, i) => ({ id: `c${i}`, name: 'counter.read', args: { value: i } }));
  const result = await runAgent(randomUUID(), task, deps([{ toolCalls }], {
    tools: [defineTool({ name: 'counter.read', schema, sideEffect: false, async run() { effects++; return effects; } })],
  }));
  expect(result.status).toBe('BUDGET_EXCEEDED');
  expect(result.budget.modelCalls).toBe(kind === 'tool' ? 6 : 8);
  expect(effects).toBe(kind === 'tool' ? 16 : 8);
});
// Missing assistant/tool IDs in the checkpoint breaks the next provider turn.
test('persists corrected messages and actual parsed arguments', async () => {
  const id = randomUUID();
  const result = await runAgent(id, task, deps([call({ value: 'bad' }), call({ value: 7, ignored: true }), { text: 'finished' }], {
    model: scripted([call({ value: 'bad' }), call({ value: 7, ignored: true }), { text: 'finished' }], (request) => {
      if (request.messages.length > 3) {
        expect(request.messages.some(m => m.role === 'tool' && m.toolCallId === 'call-1')).toBe(true);
      }
    }),
  }));
  expect(result).toMatchObject({ status: 'DONE', output: 'finished', budget: { modelCalls: 3, toolCalls: 1 } });
  const rows = await db.client.query('SELECT payload_json FROM steps WHERE run_id=$1 AND kind=$2', [id, 'tool']);
  expect(rows.rows[0].payload_json.args).toEqual({ value: 7 });
});
// A mislabeled sensitive tool must not bypass baseline approval or reuse an old identity.
test('default approval binds tenant run tool action args and immutable task', async () => {
  let effects = 0;
  const id = randomUUID();
  const tools = [defineTool({ name: 'email.send', schema, sideEffect: false, async run() { return ++effects; } })];
  const base = deps([call({ value: 1 }, 'email.send'), { text: 'sent' }], { tools });
  const waiting = await runAgent(id, task, base);
  expect(waiting.status).toBe('NEEDS_APPROVAL');
  expect(effects).toBe(0);
  const approval = waiting.approval!;
  expect(await runAgent(id, { ...task, input: 'changed' }, base)).toMatchObject({ errorCode: 'RUN_INPUT_MISMATCH' });
  expect(await runAgent(id, { ...task, tenantId: 'tenant-b' }, base)).toMatchObject({ errorCode: 'RUN_INPUT_MISMATCH' });
  expect((await runAgent(id, task, { ...base, approvals: [{ ...approval, argsHash: 'wrong' }] })).status).toBe('NEEDS_APPROVAL');
  const result = await runAgent(id, task, { ...base, store: new PostgresStore(db.url), approvals: [approval] });
  expect(result).toMatchObject({ status: 'DONE', budget: { modelCalls: 2, toolCalls: 1 } });
  expect(effects).toBe(1);
  expect((await runAgent(randomUUID(), task, deps([call({ value: 1 }, 'email.send')], { tools, approvals: [approval] }))).status).toBe('NEEDS_APPROVAL');
});
// An injected policy denial must intercept even a read, before its runner.
test('guard covers read tools and errors are safe', async () => {
  let executed = false;
  const result = await runAgent(randomUUID(), task, deps([call()], {
    guard: async () => 'deny', tools: [defineTool({ name: 'counter.read', schema, sideEffect: false, async run() { executed = true; } })],
  }));
  expect(result).toMatchObject({ status: 'FAILED', errorCode: 'TOOL_DENIED' });
  expect(executed).toBe(false);
});
// A competing process must neither execute nor mark the active run FAILED.
test('concurrent stores cannot run the same run or overwrite its status', async () => {
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const id = randomUUID();
  const first = runAgent(id, task, deps([{ text: 'done' }], { model: { async *stream() { entered(); await gate; yield { text: 'done' }; } } }));
  await ready;
  const second = await runAgent(id, task, deps([], { store: new PostgresStore(db.url) }));
  expect(second).toMatchObject({ status: 'FAILED', errorCode: 'RUN_BUSY' });
  expect(await runAgent(id.toUpperCase(), task, deps([{ text: 'must not run' }], { store: new PostgresStore(db.url) }))).toMatchObject({ errorCode: 'RUN_BUSY' });
  expect((await db.client.query('SELECT status FROM runs WHERE id=$1', [id])).rows[0].status).toBe('RUNNING');
  release(); expect((await first).status).toBe('DONE');
});
// Input/runtime provider failures must not leak raw error bodies or trigger a model after cancellation.
test('validates inputs and persists cancellation and provider errors safely', async () => {
  expect(await runAgent('bad-id', task, deps())).toMatchObject({ errorCode: 'INVALID_INPUT' });
  const controller = new AbortController(); controller.abort();
  const id = randomUUID();
  expect(await runAgent(id, task, deps([], { signal: controller.signal }))).toMatchObject({ status: 'FAILED', errorCode: 'CANCELLED', budget: { modelCalls: 0 } });
  const failed = await runAgent(randomUUID(), task, deps([], { model: { async *stream() { throw new Error('secret PII token'); } } }));
  expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_ERROR' });
  expect(JSON.stringify(failed)).not.toContain('secret');
});
// Unknown call names and malformed provider envelopes cannot turn into successful completion.
test.each([{ toolCalls: [{ id: 'x', name: 'missing', args: {} }] }, { text: 42 }, {}])('rejects invalid model response %#', async response => {
  const result = await runAgent(randomUUID(), task, deps([response as never]));
  expect(result.status).toBe('FAILED');
});
// Baseline approval is not a reusable boolean and cannot be forged by an unrelated binding.
test('does not accept partial approval', async () => {
  const result = await runAgent(randomUUID(), task, deps([call({}, 'write')], {
    tools: [defineTool({ name: 'write', schema: z.object({}), sideEffect: true, async run() { return 'bad'; } })], approvals: [{} as Approval],
  }));
  expect(result.status).toBe('NEEDS_APPROVAL');
});
// A tool may mutate its local argument object; that must not rewrite the durable approved identity.
test('tool mutation cannot corrupt approved checkpoint arguments', async () => {
  const id = randomUUID();
  const result = await runAgent(id, task, deps([call({ value: 7 }), { text: 'done' }], {
    tools: [defineTool({ name: 'counter.read', schema, sideEffect: false, async run(args) { args.value = 99; return 'ok'; } })],
  }));
  expect(result.status).toBe('DONE');
  const step = (await db.client.query('SELECT payload_json FROM steps WHERE run_id=$1 AND kind=$2', [id, 'tool'])).rows[0];
  expect(step.payload_json.args).toEqual({ value: 7 });
  const checkpoint = (await db.client.query('SELECT budget_json FROM runs WHERE id=$1', [id])).rows[0].budget_json;
  expect(checkpoint.messages.find((m: { role: string }) => m.role === 'assistant').toolCalls[0].args).toEqual({ value: 7 });
});
// Raw errors cannot smuggle arbitrary private fields into diagnostic accounting snapshots.
test('validates accounting delivery boundaries and preserves unknown costs', async () => {
  const id = randomUUID();
  const error = Object.assign(new Error('secret body'), { accounting: { secret: 'PII-token' }, observerStatus: 'failed' });
  expect(await runAgent(id, task, deps([], { model: { async *stream() { throw error; } } }))).toMatchObject({ errorCode: 'MODEL_ERROR' });
  const checkpoint = (await db.client.query('SELECT budget_json FROM runs WHERE id=$1', [id])).rows[0].budget_json;
  expect(JSON.stringify(checkpoint.deliveries)).not.toContain('PII-token');
  const successfulId = randomUUID();
  const accounting = { model: 'fixture-version', provider: 'openaiCompatible' as const, status: 'success' as const, costUsd: 0, costStatus: 'unknown' as const, attempts: [{ attempt: 1, outcome: 'success' as const, costStatus: 'unknown' as const }] };
  expect((await runAgent(successfulId, task, deps([{ text: 'done', observerStatus: 'failed', accounting }]))).status).toBe('DONE');
  const saved = (await db.client.query('SELECT budget_json FROM runs WHERE id=$1', [successfulId])).rows[0].budget_json;
  expect(saved.deliveries[0]).toMatchObject({ observerStatus: 'failed', accounting });
});
// Policy must inspect actual normalized execution arguments, without gaining write access to them.
test('guard receives isolated validated arguments for future policy checks', async () => {
  let seen: unknown; let executed: unknown;
  const result = await runAgent(randomUUID(), task, deps([call({ value: 7, stripped: true }), { text: 'done' }], {
    guard: async request => { seen = structuredClone(request.args); (request.args as { value: number }).value = 99; return 'allow'; },
    tools: [defineTool({ name: 'counter.read', schema, sideEffect: false, async run(args) { executed = args; return 'ok'; } })],
  }));
  expect(result.status).toBe('DONE'); expect(seen).toEqual({ value: 7 }); expect(executed).toEqual({ value: 7 });
});
