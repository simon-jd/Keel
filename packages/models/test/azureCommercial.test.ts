import { chmodSync, symlinkSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { configureTracing } from 'tracing/exporter';
import { createRouter } from '../src/router.js';
import { createAzureCommercialRoute, requestHash } from '../src/azureCommercial.js';
import type { ChatRequest, ModelClient } from '../src/types.js';
const root = new URL('../../../', import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), 'keel-commercial-'));
const server = setupServer();
mkdirSync(join(root, '.secrets'), { recursive: true, mode: 0o700 });
const keyDirectory = mkdtempSync(join(root, '.secrets/commercial-fixture-'));
const endpoint = 'https://keel-fixture.openai.azure.com/openai/v1';
const request: ChatRequest = { model: 'local', messages: [{ role: 'user', content: 'synthetic fixture' }], tools: [], temperature: 0, seed: 0, maxTokens: 2048 };
let sequence = 0;
function fixture() {
  const dir = join(temporary, String(++sequence));
  mkdirSync(dir);
  const ledger = join(dir, 'ledger.json'); const keyFile = join(keyDirectory, String(sequence));
  writeFileSync(keyFile, 'fixture-private-key', { mode: 0o600 });
  writeFileSync(ledger, JSON.stringify({ schema_version: 1, project: 'keel', currency: 'USD', project_limit_usd: '10', gate_usd: '9', reservations: [] }));
  const binding = { endpoint, deployment: 'keel-mini', model: 'gpt-4.1-mini', version: '2025-04-14', region: 'eastus', sku: 'GlobalStandard', quote_id: 'fixture-retail-meters', request_hashes: [requestHash(request, 'keel-mini')] };
  const quote = { kind: 'commercial_api', provider: 'azure', currency: 'USD', unit: 'token', source: 'https://prices.azure.com/api/retail/prices', quoted_at: new Date(Date.now() - 1000).toISOString(), valid_until: new Date(Date.now() + 3600000).toISOString(), model: binding.model, version: binding.version, sku: binding.sku, region: binding.region, quote_id: binding.quote_id, input_usd_per_unit: '0.0000004', output_usd_per_unit: '0.0000016' };
  const result = spawnSync('python3', ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);import budget;d=json.load(sys.stdin);print(json.dumps(budget.reserve_commercial(d["ledger"],d["quote"],d["binding"])))', join(root, 'scripts')], { input: JSON.stringify({ ledger, quote, binding }), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const reservationId = JSON.parse(result.stdout).reservation_id as string;
  return { ledger, keyFile, reservationId, binding, inputPerMillion: '0.4', outputPerMillion: '1.6' };
}
async function collect(client: ModelClient, req = request, signal = new AbortController().signal) { const out = []; for await (const chunk of client.stream(req, { signal })) out.push(chunk); return out; }
const sse = 'data: {"choices":[{"index":0,"delta":{"content":"fixture"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
let dispatches = 0;
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); dispatches = 0; });
afterAll(() => { server.close(); rmSync(keyDirectory, { recursive: true, force: true }); rmSync(temporary, { recursive: true, force: true }); });
function respond() { server.use(http.post(`${endpoint}/chat/completions`, ({ request: wire }) => { dispatches++; expect(wire.redirect).toBe('error'); return new HttpResponse(sse, { headers: { 'content-type': 'text/event-stream' } }); })); }
it('claims once before dispatch and permanently caps concurrent attempts at ten', async () => {
  const config = fixture(); respond();
  const route = await createAzureCommercialRoute(config);
  const client = createRouter({ local: route });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => collect(client)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
  expect(dispatches).toBe(10);
  expect(JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0]).toMatchObject({ status: 'running', attempts: expect.any(Array), known_cost_usd: '0.0000240' });
  await expect(createAzureCommercialRoute(config)).rejects.toMatchObject({ code: 'budget_denied' });
  await expect(createAzureCommercialRoute({ ...config, reservationId: 'missing' })).rejects.toMatchObject({ code: 'budget_denied' });
});
it('sends only fixed Azure wire fields and refuses unapproved input before consuming', async () => {
  const config = fixture();
  let body: Record<string, unknown> = {};
  server.use(http.post(`${endpoint}/chat/completions`, async ({ request: wire }) => { dispatches++; const raw = await wire.text(); body = JSON.parse(raw) as Record<string, unknown>; expect(createHash('sha256').update(raw).digest('hex')).toBe(config.binding.request_hashes[0]); expect(wire.headers.get('api-key')).toBe('fixture-private-key'); return new HttpResponse(sse, { headers: { 'content-type': 'text/event-stream' } }); }));
  const client = createRouter({ local: await createAzureCommercialRoute(config) });
  for (const changed of [{ maxTokens: 2049 }, { n: 2 }, { messages: [{ role: 'user', content: 'private-input' }] }, { tools: [{ type: 'web_search' }] }, { messages: [{ role: 'user', content: '界'.repeat(16000) }] }, { tools: [{ name: 'fixture', parameters: {}, description: 'x'.repeat(33000) }] }]) {
    await expect(collect(client, { ...request, ...changed } as ChatRequest)).rejects.toMatchObject({ code: 'invalid_request' });
  }
  expect(dispatches).toBe(0);
  await collect(client);
  expect(body).toMatchObject({ model: 'keel-mini', n: 1, max_completion_tokens: 2048, seed: 0, temperature: 0 });
  expect(body).not.toHaveProperty('max_tokens');
  expect(JSON.stringify(JSON.parse(readFileSync(config.ledger, 'utf8')))).not.toMatch(/fixture-private-key|synthetic fixture|private-input/);
});
it('each 429, 5xx and interrupted stream consumes an attempt and retains known subtotal', async () => {
  const config = fixture(); let count = 0;
  server.use(http.post(`${endpoint}/chat/completions`, () => { dispatches++; count++; return count <= 2 ? new HttpResponse('private-provider-error', { status: count === 1 ? 429 : 503 }) : new HttpResponse(count === 3 ? sse.replace('data: [DONE]\n\n', '') : sse, { headers: { 'content-type': 'text/event-stream' } }); }));
  const result = await collect(createRouter({ local: await createAzureCommercialRoute(config) }));
  expect(dispatches).toBe(4);
  expect(result[0]?.accounting).toMatchObject({ costStatus: 'unknown' });
  expect(result[0]?.accounting?.costUsd).toBeCloseTo(0.0000048, 12);
  const item = JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0];
  expect(item.attempts).toHaveLength(4); expect(item.known_cost_usd).toBe('0.0000048'); expect(item.cost_status).toBe('unknown'); expect(item.estimate_usd).toBe('4.223072000');
}, 15000);

it('rejects absent guards, route tampering and unsafe credential files with zero dispatch', async () => {
  const config = fixture(); respond();
  const route = await createAzureCommercialRoute(config);
  for (const changed of [{ provider: 'openai' as const }, { commercial: {} }, { endpoint: 'https://other.openai.azure.com/openai/v1' }, { model: 'other' }, { apiKey: 'forbidden' }, { pricing: { inputPerMillion: 0, outputPerMillion: 0 } }]) {
    await expect(async () => collect(createRouter({ local: { ...route, ...changed } }))).rejects.toMatchObject({ code: 'budget_denied' });
  }
  expect(dispatches).toBe(0);
  const item = JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0];
  expect(item.attempts).toEqual([]);
  const unsafe = fixture();
  chmodSync(unsafe.keyFile, 0o644);
  await expect(createAzureCommercialRoute(unsafe)).rejects.toMatchObject({ code: 'configuration' });
  chmodSync(unsafe.keyFile, 0o600);
  const link = join(keyDirectory, 'link'); symlinkSync(unsafe.keyFile, link);
  await expect(createAzureCommercialRoute({ ...unsafe, keyFile: link })).rejects.toMatchObject({ code: 'configuration' });
  const fifo = join(keyDirectory, 'fifo'); expect(spawnSync('mkfifo', ['-m', '600', fifo]).status).toBe(0);
  await expect(createAzureCommercialRoute({ ...unsafe, keyFile: fifo })).rejects.toMatchObject({ code: 'configuration' });
  expect(dispatches).toBe(0);
});
it('cancellation after admission retains the durable unknown attempt', async () => {
  const config = fixture(); const controller = new AbortController();
  server.use(http.post(`${endpoint}/chat/completions`, () => { dispatches++; controller.abort(); return new HttpResponse(null, { status: 503 }); }));
  await expect(collect(createRouter({ local: await createAzureCommercialRoute(config) }), request, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  const item = JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0];
  expect(dispatches).toBe(1); expect(item.attempts).toHaveLength(1); expect(item.cost_status).toBe('unknown');
});
it('expired claimed reservations and exhausted retry admission dispatch nothing further', async () => {
  const expired = fixture(); const route = await createAzureCommercialRoute(expired);
  const ledger = JSON.parse(readFileSync(expired.ledger, 'utf8')); ledger.reservations[0].quote.valid_until = '2000-01-01T00:00:00Z'; writeFileSync(expired.ledger, JSON.stringify(ledger));
  respond();
  await expect(collect(createRouter({ local: route }))).rejects.toMatchObject({ code: 'budget_denied', accounting: { attempts: [] } });
  expect(dispatches).toBe(0);
  const config = fixture(); const client = createRouter({ local: await createAzureCommercialRoute(config) });
  for (let i = 0; i < 9; i++) await collect(client);
  server.resetHandlers(); server.use(http.post(`${endpoint}/chat/completions`, () => { dispatches++; return new HttpResponse('private-error', { status: 503 }); }));
  await expect(collect(client)).rejects.toMatchObject({ code: 'budget_exhausted', accounting: { attempts: [{ outcome: 'failed', costStatus: 'unknown' }] } });
  expect(dispatches).toBe(10);
  expect(JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0].attempts).toHaveLength(10);
});

it('exports real safe Azure accounting spans without keys, prompts, bodies or endpoints', async () => {
  const config = fixture(); respond(); const spans: unknown[] = [];
  const tracing = configureTracing({ exporter: { export(values, done) { spans.push(...values.map(s => ({ attributes: s.attributes, context: s.spanContext() }))); done({ code: 0 }); }, async shutdown() {} } });
  try {
    await collect(createRouter({ local: await createAzureCommercialRoute(config) }));
    await tracing.forceFlush();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ attributes: { 'gen_ai.provider.name': 'azureCommercial', 'gen_ai.request.model': 'keel-mini', 'keel.attempt_count': 1, 'keel.cost_status': 'known' } });
    expect(JSON.stringify(spans)).not.toMatch(/fixture-private-key|synthetic fixture|openai.azure.com|Bearer|api-key/);
  } finally { await tracing.shutdown(); }
});

it('wrong fixed endpoint, deployment, model, version and persisted caps cannot dispatch', async () => {
  const config = fixture(); respond();
  for (const changed of [{ endpoint: 'http://keel-fixture.openai.azure.com/openai/v1' }, { model: 'gpt-4.1-nano' }, { version: '2026-01-01' }, { region: 'centralus' }]) {
    await expect(createAzureCommercialRoute({ ...config, binding: { ...config.binding, ...changed } })).rejects.toMatchObject({ code: 'configuration' });
  }
  await expect(createAzureCommercialRoute({ ...config, binding: { ...config.binding, deployment: 'other-deployment' } })).rejects.toMatchObject({ code: 'budget_denied' });
  const ledger = JSON.parse(readFileSync(config.ledger, 'utf8')); ledger.reservations[0].max_output_tokens = 4096; writeFileSync(config.ledger, JSON.stringify(ledger));
  await expect(createAzureCommercialRoute(config)).rejects.toMatchObject({ code: 'budget_denied' });
  expect(dispatches).toBe(0);
});
it('admits westus only after the audited zero-attempt operator transition and retains ten-attempt ceiling', async () => {
  const config = fixture();
  const item = JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0];
  const binding = { ...config.binding, endpoint: 'https://keel-west-fixture.openai.azure.com/openai/v1', region: 'westus', quote_id: 'fixture-west-retail-meters' };
  const quote = { ...item.quote, region: 'westus', quote_id: binding.quote_id };
  await expect(createAzureCommercialRoute({ ...config, binding })).rejects.toMatchObject({ code: 'budget_denied' });
  const quoteFile = join(temporary, 'west-quote.json'); const bindingFile = join(temporary, 'west-binding.json');
  writeFileSync(quoteFile, JSON.stringify(quote)); writeFileSync(bindingFile, JSON.stringify(binding));
  const rebound = spawnSync('python3', [join(root, 'scripts/budget.py'), '--ledger', config.ledger, 'rebind-commercial-unstarted', '--reservation', config.reservationId, '--quote', quoteFile, '--binding', bindingFile], { encoding: 'utf8' });
  expect(rebound.status).toBe(0);
  await expect(createAzureCommercialRoute(config)).rejects.toMatchObject({ code: 'budget_denied' });
  server.use(http.post(`${binding.endpoint}/chat/completions`, async ({ request: wire }) => { dispatches++; const raw = await wire.text(); expect(createHash('sha256').update(raw).digest('hex')).toBe(config.binding.request_hashes[0]); return new HttpResponse(sse, { headers: { 'content-type': 'text/event-stream' } }); }));
  const client = createRouter({ local: await createAzureCommercialRoute({ ...config, binding }) });
  for (let i = 0; i < 10; i++) await collect(client);
  await expect(collect(client)).rejects.toMatchObject({ code: 'budget_exhausted', accounting: { attempts: [] } });
  expect(dispatches).toBe(10);
  const after = JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0];
  expect(after.id).toBe(config.reservationId); expect(after.attempts).toHaveLength(10); expect(after.regional_rebinds[0].from_binding).toEqual(config.binding);
});
it('rejects unaudited westus ledger edits with zero dispatch', async () => {
  const config = fixture(); const ledger = JSON.parse(readFileSync(config.ledger, 'utf8'));
  const binding = { ...config.binding, region: 'westus' };
  ledger.reservations[0].binding = binding; ledger.reservations[0].quote.region = 'westus'; writeFileSync(config.ledger, JSON.stringify(ledger));
  await expect(createAzureCommercialRoute({ ...config, binding })).rejects.toMatchObject({ code: 'budget_denied' });
  expect(dispatches).toBe(0);
});
it('one operator recovery invalidates stale guarded clients and cannot reopen any consumed attempt', async () => {
  const config = fixture(); const item = JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0];
  const binding = { ...config.binding, region: 'westus', quote_id: 'fixture-recovery-west' };
  const quoteFile = join(temporary, 'recovery-west-quote.json'); const bindingFile = join(temporary, 'recovery-west-binding.json');
  writeFileSync(quoteFile, JSON.stringify({ ...item.quote, region: 'westus', quote_id: binding.quote_id })); writeFileSync(bindingFile, JSON.stringify(binding));
  expect(spawnSync('python3', [join(root, 'scripts/budget.py'), '--ledger', config.ledger, 'rebind-commercial-unstarted', '--reservation', config.reservationId, '--quote', quoteFile, '--binding', bindingFile]).status).toBe(0);
  const current = { ...config, binding }; const stale = createRouter({ local: await createAzureCommercialRoute(current) });
  const recover = () => spawnSync('python3', [join(root, 'scripts/budget.py'), '--ledger', config.ledger, 'recover-commercial-undispatched', '--reservation', config.reservationId]);
  expect(recover().status).toBe(0); respond();
  await expect(collect(stale)).rejects.toMatchObject({ code: 'budget_denied', accounting: { attempts: [] } }); expect(dispatches).toBe(0);
  const fresh = createRouter({ local: await createAzureCommercialRoute(current) });
  await expect(collect(stale)).rejects.toMatchObject({ code: 'budget_denied', accounting: { attempts: [] } }); expect(dispatches).toBe(0);
  for (let i = 0; i < 10; i++) await collect(fresh);
  expect(recover().status).toBe(1);
  await expect(collect(fresh)).rejects.toMatchObject({ code: 'budget_exhausted', accounting: { attempts: [] } }); expect(dispatches).toBe(10);
  const after = JSON.parse(readFileSync(config.ledger, 'utf8')).reservations[0];
  expect(after.claim_recoveries).toHaveLength(1); expect(after.claim_recoveries[0].prior_state.attempts).toEqual([]); expect(after.attempts).toHaveLength(10); expect(after.estimate_usd).toBe(item.estimate_usd);
});
