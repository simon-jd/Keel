import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import { GenericContainer, Wait } from 'testcontainers';
import protobuf from 'protobufjs';
import YAML from 'yaml';
import { configureTracing } from '../src/exporter.js';
import { withSpan } from '../src/span.js';

const wire = protobuf.parse(readFileSync(new URL('./fixtures/otlp.proto', import.meta.url), 'utf8')).root.lookupType('ExportTraceServiceRequest');
// Break: collector endpoint/signal/auth headers or the opt-in privacy pipeline are misconfigured.
test('real collector forwards sanitized OTLP to a local Langfuse protocol fixture', async () => {
  const received: { path: string | undefined; type: string | undefined; auth: string | undefined; version: string | string[] | undefined; body: Buffer }[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url, type: request.headers['content-type'], auth: request.headers.authorization, version: request.headers['x-langfuse-ingestion-version'], body: Buffer.concat(chunks) });
    reply.writeHead(200, { 'Content-Type': 'application/x-protobuf' }); reply.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture bind failed');
  // Identity /redact fixture: the default PII stage would otherwise depend on whatever listens on :18082.
  const pii = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(Buffer.concat(chunks));
  });
  pii.listen(0, '127.0.0.1'); await once(pii, 'listening');
  const piiAddress = pii.address(); if (!piiAddress || typeof piiAddress === 'string') throw new Error('pii fixture bind failed');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const ingress = probe.address(); if (!ingress || typeof ingress === 'string') throw new Error('fixture port unavailable');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const config = YAML.parse(readFileSync(new URL('../../../infra/otel-collector.langfuse.yaml', import.meta.url), 'utf8'));
  config.receivers.otlp.protocols = { http: { endpoint: `127.0.0.1:${ingress.port}` } };
  config.exporters['otlphttp/langfuse'].endpoint = `http://127.0.0.1:${address.port}/api/public/otel`;
  config.exporters['otlphttp/langfuse'].compression = 'none';
  const auth = Buffer.from('fixture-public:fixture-secret').toString('base64');
  let collector: Awaited<ReturnType<GenericContainer['start']>> | undefined;
  let tracing: ReturnType<typeof configureTracing> | undefined;
  try {
    collector = await new GenericContainer('otel/opentelemetry-collector-contrib:0.160.0')
      .withNetworkMode('host').withLabels({ 'com.keel.project': 'keel', 'com.keel.owner': 'codex-keel', purpose: 'tracing-protocol-tests' })
      .withResourcesQuota({ memory: 256 * 1024 * 1024, cpu: 1 })
      .withEnvironment({ LANGFUSE_OTLP_AUTH_BASE64: auth })
      .withCopyContentToContainer([{ content: YAML.stringify(config), target: '/tmp/keel-otel.yaml' }])
      .withCommand(['--config=/tmp/keel-otel.yaml']).withWaitStrategy(Wait.forLogMessage('Everything is ready. Begin running and processing data.')).start();
    tracing = configureTracing({ endpoint: `http://127.0.0.1:${ingress.port}/v1/traces`, piiEndpoint: `http://127.0.0.1:${piiAddress.port}/redact` });
    const runId = randomUUID();
    await withSpan('llm', { 'gen_ai.system': 'openai', 'gen_ai.request.model': 'fixture-v1', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 4, 'keel.cost_usd': 0.000036, 'keel.run_id': runId, prompt: 'alice@example.com secret-token' }, async () => 'private result');
    await tracing.forceFlush();
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(1);
    const request = received[0]!;
    expect(request).toMatchObject({ path: '/api/public/otel/v1/traces', type: 'application/x-protobuf', auth: `Basic ${auth}`, version: '4' });
    const decoded = wire.toObject(wire.decode(request.body), { defaults: true, longs: Number, bytes: String });
    const resource = decoded.resourceSpans[0]; const scope = resource.scopeSpans[0]; const span = scope.spans[0];
    expect(resource.resource.attributes).toEqual([{ key: 'service.name', value: expect.objectContaining({ stringValue: 'keel' }) }]);
    expect(scope.scope).toMatchObject({ name: 'keel', version: '', attributes: [] });
    expect(span).toMatchObject({ name: 'llm', events: [], links: [], traceState: '', status: { code: 0, message: '' } });
    for (const [key, field, value] of [['gen_ai.system', 'stringValue', 'openai'], ['gen_ai.request.model', 'stringValue', 'fixture-v1'], ['gen_ai.usage.input_tokens', 'intValue', 10], ['gen_ai.usage.output_tokens', 'intValue', 4], ['keel.cost_usd', 'doubleValue', 0.000036], ['keel.run_id', 'stringValue', runId]] as const) {
      expect(span.attributes).toContainEqual({ key, value: expect.objectContaining({ [field]: value }) });
    }
    expect(JSON.stringify(decoded)).not.toMatch(/alice@example|secret-token|private result/);
    // Send untrusted OTLP directly, bypassing the application's exporter, to prove collector defenses.
    const rawSpan = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'llm', kind: 3,
      startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000', traceState: 'vendor=secret-token',
      status: { code: 2, message: 'alice@example.com secret-token' },
      attributes: [{ key: 'prompt', value: { stringValue: 'alice@example.com' } }, { key: 'keel.cost_usd', value: { doubleValue: 0.25 } }] };
    const raw = { resourceSpans: [{ schemaUrl: 'https://secret-token.invalid', resource: { attributes: [{ key: 'host.name', value: { stringValue: 'alice@example.com' } }] }, scopeSpans: [{ schemaUrl: 'https://secret-token.invalid', scope: { name: 'keel', version: 'secret-token', attributes: [{ key: 'token', value: { stringValue: 'secret-token' } }] }, spans: [rawSpan,
      { ...rawSpan, spanId: 'c'.repeat(16), events: [{ name: 'secret-token', timeUnixNano: '1000000000' }] },
      { ...rawSpan, spanId: 'd'.repeat(16), links: [{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceState: 'vendor=secret-token' }] },
      { ...rawSpan, spanId: 'e'.repeat(16), attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'alice@example.com' } }] },
    ] }] }] };
    const accepted = await fetch(`http://127.0.0.1:${ingress.port}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(raw) });
    expect(accepted.status).toBe(200);
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(2);
    const sanitized = wire.toObject(wire.decode(received[1]!.body), { defaults: true, longs: Number, bytes: String });
    const safeScope = sanitized.resourceSpans[0].scopeSpans[0];
    expect(safeScope.spans).toHaveLength(1);
    expect(safeScope.spans[0]).toMatchObject({ name: 'llm', traceState: '', events: [], links: [], status: { code: 2, message: '' } });
    expect(safeScope.spans[0].attributes).toEqual([{ key: 'keel.cost_usd', value: expect.objectContaining({ doubleValue: 0.25 }) }]);
    expect(JSON.stringify(sanitized)).not.toMatch(/alice@example|secret-token/);
  } finally { await tracing?.shutdown(); await collector?.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => pii.close(() => resolve())); }
});
