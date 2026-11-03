import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { cost, createRouter } from '../src/router.js';
import type { CallAccounting, ChatChunk, ChatRequest, ModelClient, Provider, Route } from '../src/types.js';

const openai = readFileSync(new URL('./fixtures/openai-tool.sse', import.meta.url), 'utf8');
const anthropic = readFileSync(new URL('./fixtures/anthropic-tool.sse', import.meta.url), 'utf8');
const endpoint = 'https://fixture.invalid/v1';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const req: ChatRequest = { model: 'test', messages: [{ role: 'user', content: 'weather?' }], tools: [{ name: 'weather', parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } } }] };
function route(provider: Provider = 'openai'): Route {
  return { provider, endpoint, apiKey: 'secret-fixture-key', model: provider === 'anthropic' ? 'claude-sonnet-4-5-20250929' : provider === 'openaiCompatible' ? 'deployment@revision-123' : 'gpt-4.1-mini-2025-04-14', ...(provider === 'openaiCompatible' ? { pricing: { inputPerMillion: 2, outputPerMillion: 4 } } : {}) };
}
const signal = () => new AbortController().signal;
async function collect(client: ModelClient, request = req, abortSignal = signal()): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of client.stream(request, { signal: abortSignal, run_id: 'run-1', call_id: 'call-1' })) out.push(chunk);
  return out;
}
function respond(body = openai): Response { return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } }); }
function post(handler: Parameters<typeof http.post>[1]): void { server.use(http.post(`${endpoint}/*`, handler)); }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Break: forwarding raw deltas or summing cumulative Anthropic usage changes these literal results.
it('normalizesToolCallsAcrossProviders', async () => {
  for (const provider of ['openai', 'anthropic', 'openaiCompatible'] as const) {
    post(() => respond(provider === 'anthropic' ? anthropic : openai));
    const chunks = await collect(createRouter({ test: route(provider) }));
    expect(chunks).toMatchObject([{ text: '你好 ', toolCalls: [{ id: 'call_1', name: 'weather', args: { city: '北京' } }], usage: { input: 10, output: 4 }, accounting: { provider, status: 'success', costStatus: 'known', usage: { input: 10, output: 4 }, attempts: [{ attempt: 1, outcome: 'success', costStatus: 'known' }] } }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.observerStatus).toBeUndefined();
    server.resetHandlers();
  }
});

// Break: retrying immediately, exceeding retry cap, or emitting usage for failed attempts.
it('retries429WithBackoffWithoutDoubleBilling', async () => {
  const times: number[] = [];
  const events: CallAccounting[] = [];
  post(() => { times.push(Date.now()); return times.length < 3 ? new HttpResponse('private-provider-error', { status: 429 }) : respond(); });
  const chunks = await collect(createRouter({ test: route() }, { observer: (event) => { events.push(event); } }));
  expect(times).toHaveLength(3);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(475);
  expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(975);
  expect(chunks.map((chunk) => chunk.usage)).toEqual([{ input: 10, output: 4 }]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ run_id: 'run-1', call_id: 'call-1', status: 'success', usage: { input: 10, output: 4 }, costUsd: 0.0000104 });
});

// Break: exposing partial tools/text before the terminal event or adding failed partial usage to successful usage.
it('resumesAfterStreamDropWithoutDuplicateUsage', async () => {
  let attempts = 0;
  const events: CallAccounting[] = [];
  post(() => respond(++attempts === 1 ? openai.replace('data: [DONE]\n\n', '') : openai));
  const chunks = await collect(createRouter({ test: route() }, { observer: (event) => { events.push(event); } }));
  expect(attempts).toBe(2);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.usage).toEqual({ input: 10, output: 4 });
  expect(events[0]).toMatchObject({ costUsd: 0.0000208, costStatus: 'known', attempts: [{ attempt: 1, outcome: 'failed', usage: { input: 10, output: 4 } }, { attempt: 2, outcome: 'success', usage: { input: 10, output: 4 } }] });
});

// Break: relying only on fetch abort leaves a pending body read alive; partial calls must never escape.
it('abortsOnSignal', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const startedReading = new Promise<void>((resolve) => { started = resolve; });
  post(() => new HttpResponse(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(openai.split('data: [DONE]')[0]!)); started(); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const chunks: ChatChunk[] = [];
  const pending = (async () => { for await (const chunk of createRouter({ test: route() }).stream(req, { signal: controller.signal })) chunks.push(chunk); })().then(() => undefined, (error: unknown) => error);
  await Promise.race([startedReading, pending]);
  await sleep(20);
  controller.abort();
  expect(await pending).toMatchObject({ code: 'aborted' });
  expect(chunks).toEqual([]);
});

it('cancelsDuringRealBackoffBeforeAnotherRequest', async () => {
  const controller = new AbortController();
  let attempts = 0;
  post(() => { attempts++; setTimeout(() => controller.abort(), 30); return new HttpResponse(null, { status: 429 }); });
  await expect(collect(createRouter({ test: route() }), req, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  await sleep(520);
  expect(attempts).toBe(1);
});

it('reportsUnknownFailedAttemptCostWithoutExposingItsTools', async () => {
  let attempts = 0;
  const events: CallAccounting[] = [];
  post(() => respond(++attempts === 1 ? openai.split('\n\n').slice(0, 3).join('\n\n') + '\n\n' : openai));
  const chunks = await collect(createRouter({ test: route() }, { observer: (event) => { events.push(event); } }));
  expect(chunks).toHaveLength(1);
  expect(events[0]).toMatchObject({ costStatus: 'unknown', costUsd: 0.0000104, attempts: [{ outcome: 'failed', costStatus: 'unknown' }, { outcome: 'success', costStatus: 'known' }] });
});

it('keepsMalformedToolArgsDetectableForRuntime', async () => {
  post(() => respond(openai.replace('\\"北京\\"}', 'not-json}')));
  const chunks = await collect(createRouter({ test: route() }));
  expect(chunks[0]?.toolCalls).toBeUndefined();
  expect(chunks[0]?.invalidToolCalls).toEqual([{ id: 'call_1', name: 'weather', error: 'malformed_json' }]);
});

it('treatsEmptyArgumentsOfAZeroArgumentCallAsAnEmptyObject', async () => {
  const { complete } = await import('../src/protocol.js');
  // vLLM streams no argument text for a call such as get_channels(). Whitespace is not JSON content;
  // the runtime still validates {} against the tool schema, so required parameters stay enforced.
  const tools = { ...req, tools: [...req.tools!, { name: 'list', parameters: { type: 'object', properties: {} } }] };
  const chunk = complete('', [{ id: 'a', name: 'list', json: '' }, { id: 'b', name: 'list', json: ' \n' }, { id: 'c', name: 'weather', json: '{' }], tools, { usageFinal: false });
  expect(chunk.toolCalls).toEqual([{ id: 'a', name: 'list', args: {} }, { id: 'b', name: 'list', args: {} }]);
  expect(chunk.invalidToolCalls).toEqual([{ id: 'c', name: 'weather', error: 'malformed_json' }]);
});

it('doesNotExecuteAnUndeclaredTool', async () => {
  post(() => respond(openai.replace('"name":"weather"', '"name":"shell"')));
  const chunks = await collect(createRouter({ test: route() }));
  expect(chunks[0]?.toolCalls).toBeUndefined();
  expect(chunks[0]?.invalidToolCalls).toEqual([{ id: 'call_1', name: 'shell', error: 'unknown_tool', args: { city: '北京' } }]);
});

it('preservesParsedArgsForRuntimeSchemaValidation', async () => {
  post(() => respond(openai.replace('\\"北京\\"}', '42}')));
  expect((await collect(createRouter({ test: route() })))[0]?.toolCalls).toEqual([{ id: 'call_1', name: 'weather', args: { city: 42 } }]);
});

it('doesNotRetryAnObserverFailureOrLeakPayloadToObserver', async () => {
  let attempts = 0;
  const events: CallAccounting[] = [];
  post(() => { attempts++; return respond(); });
  const chunks = await collect(createRouter({ test: route() }, { observer: async (event) => { events.push(event); throw new Error('export failed'); } }));
  expect(chunks).toHaveLength(1);
  expect(attempts).toBe(1);
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toMatch(/weather|北京|secret-fixture-key/);
});

it('usesConfiguredModelVersionAndProviderWireFormats', async () => {
  for (const provider of ['openai', 'anthropic', 'openaiCompatible'] as const) {
    let body: unknown;
    let path = '';
    let auth = '';
    post(async ({ request }) => { body = await request.json(); path = new URL(request.url).pathname; auth = request.headers.get(provider === 'anthropic' ? 'x-api-key' : 'authorization') ?? ''; return respond(provider === 'anthropic' ? anthropic : openai); });
    await collect(createRouter({ test: route(provider) }), { ...req, temperature: 0.2, maxTokens: 50 });
    expect(body).toMatchObject({ model: route(provider).model, stream: true, temperature: 0.2, max_tokens: 50 });
    expect(path).toBe(provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    expect(auth).toBe(provider === 'anthropic' ? 'secret-fixture-key' : 'Bearer secret-fixture-key');
    expect(body).toMatchObject(provider === 'anthropic' ? { tools: [{ name: 'weather', input_schema: req.tools![0]!.parameters }] } : { stream_options: { include_usage: true }, tools: [{ type: 'function', function: { name: 'weather', parameters: req.tools![0]!.parameters } }] });
    server.resetHandlers();
  }
});

it('readsUtf8SplitAcrossChunksAndMultilineSseWithCrLf', async () => {
  const bytes = new TextEncoder().encode(openai.replace('data: {"id":"chatcmpl-fixture",', 'data: {"id":"chatcmpl-fixture",\ndata: ').replaceAll('\n', '\r\n'));
  post(() => new HttpResponse(new ReadableStream({ start(stream) { for (const byte of bytes) stream.enqueue(Uint8Array.of(byte)); stream.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  expect((await collect(createRouter({ test: route() })))[0]?.text).toBe('你好 ');
});

it.each([500, 503])('retriesTransientHttp%s', async (status) => {
  let attempts = 0;
  post(() => ++attempts === 1 ? new HttpResponse('sensitive response', { status }) : respond());
  expect(await collect(createRouter({ test: route() }))).toHaveLength(1);
  expect(attempts).toBe(2);
});

it('capsExponentialRetriesAtFourAndKeepsErrorsSafe', async () => {
  let attempts = 0;
  const times: number[] = [];
  post(() => { attempts++; times.push(Date.now()); return new HttpResponse('secret-fixture-key private-provider-error', { status: 429 }); });
  const error = await collect(createRouter({ test: route() })).catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: 'http', status: 429 });
  expect(attempts).toBe(5);
  expect(times[4]! - times[3]!).toBeGreaterThanOrEqual(3975);
  expect(String(error)).not.toMatch(/secret|private|fixture.invalid/);
}, 12000);

it.each([
  ['openai', 'event: error\ndata: {"error":{"message":"private-secret"}}\n\n'],
  ['anthropic', 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"private-secret"}}\n\n'],
  ['openai', 'data: definitely-not-json\n\n'],
] as const)('rejectsErrorSseAndMalformedEventsFor%s', async (provider, body) => {
  const controller = new AbortController();
  const events: CallAccounting[] = [];
  let attempts = 0;
  post(() => { attempts++; if (attempts === 2) setTimeout(() => controller.abort(), 20); return respond(body); });
  await expect(collect(createRouter({ test: route(provider) }, { observer: (event) => { events.push(event); } }), req, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  expect(events[0]?.attempts).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain('private-secret');
});

it('doesNotAcceptDoneWithoutAnOpenaiFinishReason', async () => {
  const controller = new AbortController();
  post(() => { setTimeout(() => controller.abort(), 20); return respond(openai.replace('"finish_reason":"tool_calls"', '"finish_reason":null')); });
  await expect(collect(createRouter({ test: route() }), req, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
});

it('reportsMissingFinalUsageAsUnknownRatherThanZero', async () => {
  const events: CallAccounting[] = [];
  post(() => respond(openai.split('\n\n').filter((part) => !part.includes('"choices":[]')).join('\n\n')));
  expect((await collect(createRouter({ test: route() }, { observer: (event) => { events.push(event); } })))[0]?.usage).toBeUndefined();
  expect(events[0]).toMatchObject({ costStatus: 'unknown', costUsd: 0 });
});

it('failsClosedForUnknownModelOrUnpricedDeployment', async () => {
  expect(() => cost({ input: 1, output: 1 }, 'unknown')).toThrow();
  expect(() => createRouter({ test: { ...route('openaiCompatible'), pricing: undefined } as unknown as Route })).toThrow();
  await expect(collect(createRouter({ test: route() }), { ...req, model: 'unknown' })).rejects.toMatchObject({ code: 'configuration' });
});

it('computesKnownPriceAndExplicitDeploymentCost', () => {
  expect(cost({ input: 1_000_000, output: 500_000 }, 'gpt-4.1-mini-2025-04-14')).toBe(1.2);
  expect(cost({ input: 1_000_000, output: 500_000 }, 'deployment@revision-123', { inputPerMillion: 2, outputPerMillion: 4 })).toBe(4);
});

it.each([{ temperature: NaN }, { maxTokens: -1 }, { messages: [] }])('rejectsBadRequestBeforeNetwork%j', async (invalid) => {
  let requests = 0;
  post(() => { requests++; return respond(); });
  await expect(collect(createRouter({ test: route() }), { ...req, ...invalid })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(requests).toBe(0);
});

it('failsNonRetryableHttpWithoutLeakingServerText', async () => {
  let attempts = 0;
  post(() => { attempts++; return new HttpResponse('secret-fixture-key private-provider-error', { status: 401 }); });
  const error = await collect(createRouter({ test: route() })).catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: 'http', status: 401 });
  expect(attempts).toBe(1);
  expect(String(error)).not.toMatch(/secret|private|fixture.invalid/);
});

// Break: treating a complete JSON object as executable despite a truncation finish reason.
it.each(['openai', 'anthropic'] as const)('neverCommitsTruncatedToolCallsFor%s', async (provider) => {
  let attempts = 0;
  const fixture = provider === 'openai' ? openai : anthropic;
  const truncated = provider === 'openai' ? fixture.replace('"finish_reason":"tool_calls"', '"finish_reason":"length"') : fixture.replace('"stop_reason":"tool_use"', '"stop_reason":"max_tokens"');
  post(() => respond(++attempts === 1 ? truncated : fixture));
  const chunks = await collect(createRouter({ test: route(provider) }));
  expect(attempts).toBe(2);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.toolCalls).toEqual([{ id: 'call_1', name: 'weather', args: { city: '北京' } }]);
});

// Break: accepting message_stop while a content block is still open.
it('requiresClosedAnthropicBlocksBeforeCommittingTools', async () => {
  let attempts = 0;
  const unclosed = anthropic.replace('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n', '');
  post(() => respond(++attempts === 1 ? unclosed : anthropic));
  expect(await collect(createRouter({ test: route('anthropic') }))).toHaveLength(1);
  expect(attempts).toBe(2);
});

// Break: exposing any partial attempt, or mistaking partial cumulative usage for a final bill.
it('retriesActualReaderFailureAndReportsItsUnknownCost', async () => {
  let attempts = 0;
  const events: CallAccounting[] = [];
  post(() => {
    if (++attempts > 1) return respond();
    return new HttpResponse(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(openai.split('\n\n').slice(0, 3).join('\n\n') + '\n\n'));
      setTimeout(() => stream.error(new Error('private-transport-error')), 15);
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const chunks = await collect(createRouter({ test: route() }, { observer: (event) => { events.push(event); } }));
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ text: '你好 ', toolCalls: [{ id: 'call_1', name: 'weather', args: { city: '北京' } }], usage: { input: 10, output: 4 }, observerStatus: 'delivered' });
  expect(attempts).toBe(2);
  expect(events[0]).toMatchObject({ costStatus: 'unknown', attempts: [{ outcome: 'failed', costStatus: 'unknown' }, { outcome: 'success', costStatus: 'known' }] });
  expect(JSON.stringify(events)).not.toContain('private-transport-error');
});

// Break: generating an invalid empty Anthropic text block in a normal tool-result roundtrip.
it('serializesToolHistoryWithoutEmptyAnthropicTextBlocks', async () => {
  let body: unknown;
  post(async ({ request }) => { body = await request.json(); return respond(anthropic); });
  await collect(createRouter({ test: route('anthropic') }), { ...req, messages: [
    { role: 'system', content: 'Use tools' },
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'weather', args: { city: '北京' } }] },
    { role: 'tool', toolCallId: 'call_1', content: '{"temperature":12}' },
  ] });
  expect(body).toMatchObject({ system: 'Use tools', messages: [
    { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '北京' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"temperature":12}' }] },
  ] });
});

// Break: ignoring a present, incorrectly typed delta lets previously accumulated JSON execute.
it.each(['name', 'arguments'] as const)('discardsAttemptWithNonStringToolFunction%s', async (field) => {
  let attempts = 0;
  const corruptDelta = { id: 'chatcmpl-corrupt', object: 'chat.completion.chunk', created: 1745100000, model: 'gpt-4.1-mini-2025-04-14', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { [field]: field === 'name' ? 42 : { dangerous: true } } }] }, logprobs: null, finish_reason: null }], usage: null };
  const frames = openai.split('\n\n');
  const corrupted = [...frames.slice(0, 3), `data: ${JSON.stringify(corruptDelta)}`, ...frames.slice(3)].join('\n\n');
  post(() => respond(++attempts === 1 ? corrupted.replace('你好 ', 'discarded text') : openai));
  const chunks = await collect(createRouter({ test: route() }));
  expect(attempts).toBe(2);
  expect(chunks).toMatchObject([{ text: '你好 ', toolCalls: [{ id: 'call_1', name: 'weather', args: { city: '北京' } }], usage: { input: 10, output: 4 }, accounting: { costStatus: 'unknown', costUsd: 0.0000104, attempts: [{ attempt: 1, outcome: 'failed', costStatus: 'unknown' }, { attempt: 2, outcome: 'success', costStatus: 'known' }] } }]);
  expect(chunks).toHaveLength(1);
});

// Break: silently swallowing an exporter error loses trace/cost delivery state after a billed completion.
it('exposesObserverFailureWithIsolatedAccountingWithoutRetryingProvider', async () => {
  let attempts = 0;
  const events: CallAccounting[] = [];
  post(() => { attempts++; return respond(); });
  const chunks = await collect(createRouter({ test: route() }, { observer: async (event) => {
    events.push(structuredClone(event));
    event.costUsd = 999;
    event.attempts.length = 0;
    if (event.usage) event.usage.input = 999;
    throw new Error('private-exporter-token-and-payload');
  } }));
  expect(attempts).toBe(1);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ observerStatus: 'failed', usage: { input: 10, output: 4 }, accounting: { run_id: 'run-1', call_id: 'call-1', status: 'success', costUsd: 0.0000104, costStatus: 'known', usage: { input: 10, output: 4 }, attempts: [{ attempt: 1, outcome: 'success', costStatus: 'known', usage: { input: 10, output: 4 }, costUsd: 0.0000104 }] } });
  expect(events).toHaveLength(1);
  expect(JSON.stringify(chunks[0]?.accounting)).not.toMatch(/weather|北京|secret-fixture-key|private-exporter/);
});

it('reportsSuccessfulObserverDeliveryInResult', async () => {
  post(() => respond());
  const chunks = await collect(createRouter({ test: route() }, { observer: (event) => { event.model = 'mutated'; } }));
  expect(chunks[0]).toMatchObject({ observerStatus: 'delivered', accounting: { model: 'gpt-4.1-mini-2025-04-14', costStatus: 'known', costUsd: 0.0000104 } });
});

// Break: throwing an exporter exception instead of the safe original model error invites blind retries.
it('preservesSafeProviderErrorAndUnknownCostWhenObserverFails', async () => {
  let attempts = 0;
  let deliveries = 0;
  post(() => { attempts++; return new HttpResponse('private-provider-body', { status: 401 }); });
  const error = await collect(createRouter({ test: route() }, { observer: (event) => {
    deliveries++;
    event.costStatus = 'known';
    event.attempts.length = 0;
    throw new Error('private-observer-body');
  } })).catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: 'http', status: 401, observerStatus: 'failed', accounting: { run_id: 'run-1', call_id: 'call-1', status: 'failed', costStatus: 'unknown', costUsd: 0, attempts: [{ attempt: 1, outcome: 'failed', costStatus: 'unknown' }] } });
  expect(attempts).toBe(1);
  expect(deliveries).toBe(1);
  expect(JSON.stringify(error)).not.toMatch(/private-|secret-fixture-key|fixture.invalid|cause/);
});

it('keepsKnownFailedAttemptUsageWhenObserverDeliveryFails', async () => {
  const controller = new AbortController();
  let attempts = 0;
  post(() => { attempts++; setTimeout(() => controller.abort(), 25); return respond(openai.replace('data: [DONE]\n\n', '')); });
  const error = await collect(createRouter({ test: route() }, { observer: async () => { throw new Error('private-exporter'); } }), req, controller.signal).catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: 'aborted', observerStatus: 'failed', accounting: { status: 'aborted', costStatus: 'known', costUsd: 0.0000104, attempts: [{ attempt: 1, outcome: 'failed', costStatus: 'known', usage: { input: 10, output: 4 } }] } });
  expect(attempts).toBe(1);
});

it('forwards reproducibility seed to the compatible provider and rejects invalid seeds',async()=>{
 let body:Record<string,unknown>={};post(async({request})=>{body=await request.json() as Record<string,unknown>;return respond();});
 await collect(createRouter({test:route('openaiCompatible')}),{...req,seed:2} as ChatRequest);
 expect(body.seed).toBe(2);
 await expect(collect(createRouter({test:route('openaiCompatible')}),{...req,seed:-1} as ChatRequest)).rejects.toMatchObject({code:'invalid_request'});
});
it('preserves mixed valid and unknown call order without promoting invalid tools', async()=>{
 const {complete}=await import('../src/protocol.js');
 const chunk=complete('',[{id:'unknown',name:'other',json:'{}'},{id:'valid',name:'weather',json:'{"city":"X"}'}],req,{usageFinal:false});
 expect(chunk.toolCallOrder).toEqual(['unknown','valid']);
 expect(chunk.toolCalls?.map(c=>c.id)).toEqual(['valid']);
 expect(chunk.invalidToolCalls?.map(c=>c.id)).toEqual(['unknown']);
});
