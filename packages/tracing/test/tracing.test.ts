import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { SpanStatusCode } from '@opentelemetry/api';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { createRouter } from '../../models/src/router.js';
import { runAgent } from '../../runtime/src/loop.js';
import { defineTool } from '../../runtime/src/tools.js';
import { database, task } from '../../runtime/test/helpers.js';
import { configureTracing } from '../src/exporter.js';
import { withSpan } from '../src/span.js';

const endpoint = 'https://tracing-fixture.invalid/v1';
const server = setupServer();
let db: Awaited<ReturnType<typeof database>>;
let exporter: InMemorySpanExporter;
let tracing: ReturnType<typeof configureTracing>;
beforeAll(async () => { db = await database(); server.listen({ onUnhandledRequest: 'error' }); });
beforeEach(() => { exporter = new InMemorySpanExporter(); tracing = configureTracing({ exporter }); });
afterEach(async () => { await tracing.shutdown(); server.resetHandlers(); });
afterAll(async () => { server.close(); await db?.client.end(); await db?.container.stop(); });
const secret = 'alice@example.com secret-token-DO-NOT-EXPORT';
function sse(tool = false, usage = true): string {
  return [
    { choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: JSON.stringify({ city: secret }) } }] } : { content: secret }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
    ...(usage ? [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }] : []),
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const response = (body = sse()) => new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
function model(observer?: () => void) {
  return createRouter({ local: { provider: 'openaiCompatible', model: 'fixture-version-1', endpoint, pricing: { inputPerMillion: 2, outputPerMillion: 4 }, apiKey: secret } }, observer ? { observer } : {});
}
const spans = () => exporter.getFinishedSpans();
const exportedData = () => JSON.stringify(spans().map(s => ({ name: s.name, attributes: s.attributes, events: s.events, links: s.links, status: s.status, resource: s.resource.attributes, scope: s.instrumentationScope })));
const readTool = (traceKind: 'tool' | 'retrieval' = 'tool', fail = false) => defineTool({ name: 'weather', schema: z.object({ city: z.string() }), sideEffect: false, traceKind, async run() { if (fail) throw new Error(secret); return secret; } });

// Break: removing models instrumentation loses required attributes on the actual runtime path.
test('llmSpanHasGenAIAttributes', async () => {
  server.use(http.post(`${endpoint}/*`, () => response()));
  const id = randomUUID();
  const result = await runAgent(id, { ...task, input: secret }, { store: db.store, model: model(), tools: [] });
  await tracing.forceFlush();
  expect(result.status).toBe('DONE');
  expect(spans()).toHaveLength(1);
  expect(spans()[0]!.attributes).toMatchObject({
    'gen_ai.system': 'openaiCompatible', 'gen_ai.provider.name': 'openaiCompatible',
    'gen_ai.request.model': 'fixture-version-1', 'gen_ai.usage.input_tokens': 10,
    'gen_ai.usage.output_tokens': 4, 'keel.cost_usd': 0.000036, 'keel.run_id': id,
  });
  expect(exportedData()).not.toContain(secret);
});

// Break: observer-dependent accounting, lost checkpoint costs, or replay on terminal resume.
test('runCostEqualsSumOfCalls', async () => {
  let calls = 0;
  server.use(http.post(`${endpoint}/*`, () => response(sse(++calls === 1))));
  const id = randomUUID();
  const tools = [readTool()];
  const deps = { store: db.store, model: model(), tools, guard: async () => 'allow' as const };
  // weather is an unknown verb, so the baseline approval also exercises recovery between calls.
  const waiting = await runAgent(id, task, deps);
  expect(waiting).toMatchObject({ status: 'NEEDS_APPROVAL', cost: { status: 'known', knownUsd: 0.000036, totalUsd: 0.000036 } });
  const completed = await runAgent(id, task, { ...deps, approvals: [waiting.approval!] });
  expect(completed).toMatchObject({ status: 'DONE', cost: { status: 'known', knownUsd: 0.000072, totalUsd: 0.000072 } });
  const resumed = await runAgent(id, task, { ...deps, model: model(() => { throw new Error(secret); }) });
  expect(resumed).toEqual(completed);
  expect(calls).toBe(2);
  expect(spans().filter(s => s.name === 'llm')).toHaveLength(2);
  const saved = (await db.client.query('SELECT budget_json FROM runs WHERE id=$1', [id])).rows[0].budget_json;
  expect(saved.deliveries.map((d: { accounting?: unknown }) => d.accounting)).toHaveLength(2);
  expect(saved.deliveries[0].accounting).toMatchObject({ costStatus: 'known', costUsd: 0.000036 });
  expect(saved.deliveries[0].observerStatus).toBeUndefined();
});

// Break: retries create physical spans, or unknown failed attempts become a zero total.
test('logical retry keeps one span and known subtotal with unknown total', async () => {
  let calls = 0;
  server.use(http.post(`${endpoint}/*`, () => ++calls === 1 ? new HttpResponse(secret, { status: 429 }) : response()));
  const result = await runAgent(randomUUID(), task, { store: db.store, model: model(), tools: [] });
  expect(result).toMatchObject({ status: 'DONE', cost: { status: 'unknown', knownUsd: 0.000036, totalUsd: null } });
  expect(spans()).toHaveLength(1);
  expect(spans()[0]!.attributes).toMatchObject({ 'keel.attempt_count': 2, 'keel.cost_status': 'unknown', 'keel.unknown_attempt_count': 1, 'keel.cost_usd': 0.000036 });
  expect(calls).toBe(2);
});

// Break: missing final usage must remain unknown even when the provider finishes successfully.
test('missing usage persists unknown cost through terminal recovery', async () => {
  server.use(http.post(`${endpoint}/*`, () => response(sse(false, false))));
  const id = randomUUID(); const deps = { store: db.store, model: model(), tools: [] };
  const result = await runAgent(id, task, deps);
  expect(result).toMatchObject({ cost: { status: 'unknown', knownUsd: 0, totalUsd: null } });
  expect(await runAgent(id, task, deps)).toEqual(result);
  expect(spans()[0]!.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  expect(spans()[0]!.attributes['keel.cost_status']).toBe('unknown');
});

// Break: instrumenting just withSpan leaves real tool/retrieval executions unobserved.
test.each([{ traceKind: 'tool' as const, fail: true }, { traceKind: 'retrieval' as const, fail: true }, { traceKind: 'retrieval' as const, fail: false }])('runtime records safe $traceKind spans: failure=$fail', async ({ traceKind, fail }) => {
  let calls = 0;
  server.use(http.post(`${endpoint}/*`, () => response(sse(++calls === 1))));
  const id = randomUUID();
  const deps = { store: db.store, model: model(), tools: [readTool(traceKind, fail)] };
  const waiting = await runAgent(id, task, deps);
  expect(waiting.status).toBe('NEEDS_APPROVAL');
  expect(await runAgent(id, task, { ...deps, approvals: [waiting.approval!] })).toMatchObject(fail ? { status: 'NEEDS_APPROVAL', errorCode: 'ACTION_UNKNOWN' } : { status: 'DONE' });
  const span = spans().find(s => s.name === traceKind)!;
  expect(span).toBeDefined();
  expect(span.attributes).toMatchObject({ 'keel.run_id': id, ...(fail ? { 'error.type': 'operation_failed' } : {}) });
  expect(span.status.code).toBe(fail ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
  expect(span.events).toEqual([]);
  expect(exportedData()).not.toContain(secret);
});

// Break: provider failures/cancellation lose accounting or leak raw exception diagnostics.
test.each(['http', 'cancel'] as const)('records safe model %s failure and closes span', async kind => {
  const controller = new AbortController();
  server.use(http.post(`${endpoint}/*`, () => {
    if (kind === 'cancel') { setTimeout(() => controller.abort(), 10); return new HttpResponse(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
    return new HttpResponse(secret, { status: 400 });
  }));
  const id = randomUUID();
  const result = await runAgent(id, task, { store: db.store, model: model(), tools: [], signal: controller.signal });
  expect(result).toMatchObject({ status: 'FAILED', errorCode: kind === 'cancel' ? 'CANCELLED' : 'MODEL_ERROR', cost: { status: 'unknown', totalUsd: null } });
  expect(spans()).toHaveLength(1);
  expect(spans()[0]!.status.code).toBe(SpanStatusCode.ERROR);
  expect(spans()[0]!.events).toEqual([]);
  const saved = (await db.client.query('SELECT budget_json FROM runs WHERE id=$1', [id])).rows[0].budget_json;
  expect(saved.deliveries[0].accounting).toMatchObject({ status: kind === 'cancel' ? 'aborted' : 'failed', costStatus: 'unknown' });
  expect(exportedData()).not.toContain(secret);
});

// Break: forwarding unknown attributes, arbitrary status strings or raw span handles leaks secrets.
test('withSpan enforces a value-aware attribute whitelist and safe nested context', async () => {
  const id = randomUUID();
  await withSpan('tool', { 'keel.run_id': id, prompt: secret, 'gen_ai.request.model': secret, 'keel.cost_status': secret }, async span => {
    span.setAttributes({ 'gen_ai.usage.input_tokens': -1, 'keel.cost_usd': Infinity, 'tool.args': secret });
    await withSpan('retrieval', { 'keel.run_id': id, result: secret }, async () => 'ok');
  });
  const [child, parent] = spans();
  expect(child!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);
  expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
  expect(parent!.attributes).toEqual({ 'keel.run_id': id, 'gen_ai.operation.name': 'execute_tool' });
  expect(exportedData()).not.toContain(secret);
});

// Break: observer failure must neither suppress spans/accounting nor replay billed provider calls.
test('observer failure and consumer early return do not replay model or strand spans', async () => {
  let calls = 0;
  server.use(http.post(`${endpoint}/*`, () => { calls++; return response(); }));
  const iterator = model(() => { throw new Error(secret); }).stream({ model: 'local', messages: [{ role: 'user', content: secret }] }, { signal: new AbortController().signal, run_id: randomUUID() })[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.value).toMatchObject({ accounting: { costStatus: 'known', costUsd: 0.000036 }, observerStatus: 'failed' });
  await iterator.return?.();
  expect(calls).toBe(1);
  expect(spans()).toHaveLength(1);
  expect(spans()[0]!.status.code).not.toBe(SpanStatusCode.ERROR);
});

// Break: cumulative Anthropic output usage must not be summed across deltas.
test('Anthropic cumulative usage produces one logical cost and span', async () => {
  server.use(http.post(`${endpoint}/*`, () => response(readFileSync(new URL('../../models/test/fixtures/anthropic-tool.sse', import.meta.url), 'utf8'))));
  const client = createRouter({ local: { provider: 'anthropic', model: 'fixture-anthropic', endpoint, pricing: { inputPerMillion: 2, outputPerMillion: 4 } } });
  for await (const chunk of client.stream({ model: 'local', messages: [{ role: 'user', content: secret }], tools: [{ name: 'weather', parameters: { type: 'object' } }] }, { signal: new AbortController().signal, run_id: randomUUID() })) {
    expect(chunk.accounting).toMatchObject({ costStatus: 'known', costUsd: 0.000036, usage: { input: 10, output: 4 } });
  }
  expect(spans()).toHaveLength(1);
  expect(spans()[0]!.attributes).toMatchObject({ 'gen_ai.usage.output_tokens': 4, 'keel.cost_usd': 0.000036 });
});

// Break: lost accounting for an already reserved model must not make a recovered total look complete.
test('recovery preserves known subtotal and flags a reservation without accounting', async () => {
  server.use(http.post(`${endpoint}/*`, () => response()));
  const id = randomUUID(); const deps = { store: db.store, model: model(), tools: [] };
  await runAgent(id, task, deps);
  await db.client.query("UPDATE runs SET budget_json=jsonb_set(budget_json, '{used,modelCalls}', '2'::jsonb) WHERE id=$1", [id]);
  expect(await runAgent(id, task, deps)).toMatchObject({ cost: { status: 'unknown', knownUsd: 0.000036, totalUsd: null } });
  expect(spans()).toHaveLength(1);
});

// Break: logical span tokens must include known usage from a failed billed attempt, once per attempt.
test('known billed retry sums attempt usage and cost once', async () => {
  let calls = 0;
  server.use(http.post(`${endpoint}/*`, () => response(++calls === 1 ? sse().replace('data: [DONE]\n\n', '') : sse())));
  const result = await runAgent(randomUUID(), task, { store: db.store, model: model(), tools: [] });
  expect(result).toMatchObject({ cost: { status: 'known', knownUsd: 0.000072, totalUsd: 0.000072 } });
  expect(spans()).toHaveLength(1);
  expect(spans()[0]!.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 20, 'gen_ai.usage.output_tokens': 8, 'keel.cost_usd': 0.000072, 'keel.attempt_count': 2 });
});

// Break: a failing telemetry backend may lose telemetry but cannot replay the model or lose durable accounting.
test('export failure keeps model execution and checkpoint cost independent', async () => {
  await tracing.shutdown();
  tracing = configureTracing({ exporter: { export(_spans, callback) { callback({ code: 1, error: new Error(secret) }); }, async shutdown() {} } });
  let calls = 0;
  server.use(http.post(`${endpoint}/*`, () => { calls++; return response(); }));
  const id = randomUUID(); const deps = { store: db.store, model: model(), tools: [] };
  const result = await runAgent(id, task, deps);
  expect(result).toMatchObject({ status: 'DONE', cost: { status: 'known', knownUsd: 0.000036, totalUsd: 0.000036 } });
  expect(await runAgent(id, task, deps)).toEqual(result);
  expect(calls).toBe(1);
});

// Break: a non-JSON result fails the runtime operation and must not leave a successful tool span.
test('non-JSON tool results mark the actual tool span as error', async () => {
  server.use(http.post(`${endpoint}/*`, () => response(sse(true))));
  const id = randomUUID();
  const deps = { store: db.store, model: model(), tools: [defineTool({ name: 'weather', schema: z.object({ city: z.string() }), sideEffect: false, async run() { return 1n; } })] };
  const waiting = await runAgent(id, task, deps);
  expect(await runAgent(id, task, { ...deps, approvals: [waiting.approval!] })).toMatchObject({ status: 'NEEDS_APPROVAL', errorCode: 'ACTION_UNKNOWN' });
  expect(spans().find(s => s.name === 'tool')!.status.code).toBe(SpanStatusCode.ERROR);
});
