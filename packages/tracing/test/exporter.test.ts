import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, test, vi } from 'vitest';
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { trace } from '@opentelemetry/api';
import { configureTracing, createPrivacyExporter } from '../src/exporter.js';
import { withSpan } from '../src/span.js';

// Break: trusting an SDK span's events/status/links/resource lets raw content bypass initial attribute filtering.
test('export boundary strips all SDK content surfaces and preserves safe metrics', async () => {
  const sink = new InMemorySpanExporter();
  const provider = new TracerProvider({ resource: resourceFromAttributes({ 'service.name': 'alice@example.com', 'host.name': 'secret-host' }), spanProcessors: [new SimpleSpanProcessor({ exporter: createPrivacyExporter(sink) })] });
  const span = provider.getTracer('secret-scope').startSpan('alice@example.com', { links: [{ context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }, attributes: { secret: 'token' } }] });
  span.setAttributes({ prompt: 'alice@example.com', 'keel.cost_usd': 0.123, 'keel.cost_status': 'private', 'gen_ai.request.model': 'alice@example.com' });
  span.addEvent('secret event', { token: 'secret' });
  span.setStatus({ code: 2, message: 'secret exception stack' });
  span.end();
  await provider.forceFlush();
  const exported = sink.getFinishedSpans()[0]!;
  expect(exported.name).toBe('operation');
  expect(exported.attributes).toEqual({ 'keel.cost_usd': 0.123 });
  expect(exported.events).toEqual([]);
  expect(exported.links).toEqual([]);
  expect(exported.status).toEqual({ code: 2 });
  expect(exported.resource.attributes).toEqual({ 'service.name': 'keel' });
  expect(exported.instrumentationScope).toEqual({ name: 'keel' });
  await provider.shutdown();
});

// Break: missing OTLP protocol export or an incorrect signal path silently loses real spans.
test.each(['explicit', 'signal-env', 'base-env'] as const)('OTLP exporter posts protobuf using %s configuration', async source => {
  const received: { path: string | undefined; type: string | undefined; body: Buffer }[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url, type: request.headers['content-type'], body: Buffer.concat(chunks) });
    reply.writeHead(200, { 'Content-Type': 'application/x-protobuf' }); reply.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture bind failed');
  const endpoint = `http://127.0.0.1:${address.port}/v1/traces`;
  vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', source === 'signal-env' ? endpoint : '');
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', source === 'base-env' ? `http://127.0.0.1:${address.port}` : '');
  if (source !== 'signal-env') delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const tracing = configureTracing({ ...(source === 'explicit' ? { endpoint } : {}), batch: false });
  try {
    await withSpan('retrieval', { query: 'alice@example.com', 'keel.cost_usd': 0 }, async () => 'private result');
    await tracing.forceFlush();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ path: '/v1/traces', type: 'application/x-protobuf' });
    expect(received[0]!.body.includes(Buffer.from('retrieval'))).toBe(true);
    expect(received[0]!.body.includes(Buffer.from('alice@example.com'))).toBe(false);
    expect(received[0]!.body.includes(Buffer.from('private result'))).toBe(false);
  } finally { await tracing.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); }
});

// Break: URL secrets, fragments, or a wrong signal path must not become an export destination.
test.each(['ftp://localhost/v1/traces', 'http://user:secret@localhost/v1/traces', 'http://localhost/v1/traces?token=secret', 'http://localhost/v1/traces#secret', 'http://localhost/wrong'])('rejects unsafe OTLP endpoint %#', endpoint => {
  expect(() => configureTracing({ endpoint })).toThrow('INVALID_OTLP_ENDPOINT');
});

// Break: a default global tracer can bypass this package's privacy exporter and leak foreign resources.
test('unconfigured tracing never exports through an unrelated global provider', async () => {
  const sink = new InMemorySpanExporter();
  const provider = new TracerProvider({ resource: resourceFromAttributes({ 'host.name': 'alice@example.com' }), spanProcessors: [new SimpleSpanProcessor({ exporter: sink })] });
  trace.setGlobalTracerProvider(provider);
  try {
    await withSpan('tool', {}, async () => 'private result');
    await provider.forceFlush();
    expect(sink.getFinishedSpans()).toHaveLength(0);
  } finally { trace.disable(); await provider.shutdown(); }
});
