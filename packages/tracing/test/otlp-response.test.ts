import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { inspect } from 'node:util';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { expect, test, vi } from 'vitest';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { configureTracing, createPrivacyExporter } from '../src/exporter.js';
import { createSafeOtlpExporter } from '../src/otlpExporter.js';
import { withSpan } from '../src/span.js';

const canary = 'fixture-audit@example.com fixture-private-token';
// Break: the 0.223 upstream delegate logs a malformed 2xx protobuf body before its callback.
test('malformed HTTP 2xx protobuf never reaches real SDK diagnostics', async () => {
  const diagnostics: unknown[][] = [];
  const capture = (...args: unknown[]) => { diagnostics.push(args.map(arg => arg instanceof Uint8Array ? Buffer.from(arg).toString('utf8') : arg)); };
  diag.setLogger({ error: capture, warn: capture, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain real protobuf request */ }
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(canary);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_BIND_FAILED');
  const tracing = configureTracing({ endpoint: `http://127.0.0.1:${address.port}/v1/traces`, batch: false });
  try {
    await withSpan('tool', {}, () => undefined);
    await tracing.forceFlush().catch(() => undefined);
    expect(inspect(diagnostics, { depth: 8 })).not.toContain(canary);
  } finally {
    await tracing.shutdown(); diag.disable();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// Break: even valid protobuf partial-success error_message is arbitrary receiver data and must not enter diag.
test('valid partial-success protobuf preserves counts with safe diagnostics', async () => {
  const diagnostics: unknown[][] = [];
  const capture = (...args: unknown[]) => { diagnostics.push(args); };
  diag.setLogger({ error: capture, warn: capture, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  // Hand-encoded OTLP ExportTraceServiceResponse { partial_success: { rejected_spans: 1, error_message: canary } }.
  const message = Buffer.from(canary);
  const partial = Buffer.concat([Buffer.from([8, 1, 18, message.length]), message]);
  const response = Buffer.concat([Buffer.from([10, partial.length]), partial]);
  const server = createServer(async (req, res) => { for await (const _ of req) { /* drain */ } res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_BIND_FAILED');
  const tracing = configureTracing({ endpoint: `http://127.0.0.1:${address.port}/v1/traces`, batch: false });
  try {
    await withSpan('tool', {}, () => undefined); await tracing.forceFlush();
    expect(inspect(diagnostics, { depth: 8 })).not.toContain(canary);
    expect(inspect(diagnostics, { depth: 8 })).toContain('rejectedSpans');
    expect(inspect(diagnostics, { depth: 8 })).toContain('1');
  } finally { await tracing.shutdown(); diag.disable(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


// Break: adapting response decoding must preserve request configuration and valid empty-protobuf success.
test('owned OTLP delegate preserves headers and valid request protobuf', async () => {
  const requests: { path: string | undefined; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_BIND_FAILED');
  vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'authorization=Basic%20Zml4dHVyZQ==,x-langfuse-ingestion-version=4');
  const tracing = configureTracing({ endpoint: `http://127.0.0.1:${address.port}/v1/traces`, batch: false });
  try {
    await withSpan('tool', { 'keel.cost_usd': 0 }, () => undefined); await tracing.forceFlush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/v1/traces');
    expect(requests[0]!.headers).toMatchObject({ authorization: 'Basic Zml4dHVyZQ==', 'x-langfuse-ingestion-version': '4', 'content-type': 'application/x-protobuf' });
    expect(requests[0]!.body.includes(Buffer.from('tool'))).toBe(true);
    expect(requests[0]!.body.includes(Buffer.from('keel.cost_usd'))).toBe(true);
  } finally { await tracing.shutdown(); vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// Break: a local response sanitizer may not convert transport errors to success or leak raw HTTP errors through SDK flush.
test.each(['non2xx', 'network'] as const)('owned OTLP %s failure retains safe SDK rejection and lifecycle', async mode => {
  const diagnostics: unknown[][] = [];
  const capture = (...args: unknown[]) => { diagnostics.push(args); };
  diag.setLogger({ error: capture, warn: capture, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (mode === 'network') { req.socket.destroy(); return; }
    res.writeHead(400, canary); res.end(canary);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_BIND_FAILED');
  const exporter = createPrivacyExporter(createSafeOtlpExporter({ url: `http://127.0.0.1:${address.port}/v1/traces`, timeoutMillis: 50 }));
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  try {
    provider.getTracer('keel').startSpan('tool').end();
    const failure: unknown = await provider.forceFlush().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeDefined();
    expect(inspect(failure)).toContain('TRACE_EXPORT_FAILED');
    expect(inspect({ failure, diagnostics }, { depth: 8 })).not.toContain(canary);
    expect(diagnostics.length).toBeGreaterThan(0);
  } finally { await provider.shutdown(); diag.disable(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// Break: the built-in OTLP exporter must fail closed when an operator omits the PII sidecar configuration.
test('built-in OTLP defaults to the loopback PII sidecar and never exports an unscanned phone', async () => {
  const bodies: Buffer[] = [];
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); bodies.push(Buffer.concat(chunks)); res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_BIND_FAILED');
  vi.stubEnv('KEEL_PII_ENDPOINT', '');
  const tracing = configureTracing({ endpoint: `http://127.0.0.1:${address.port}/v1/traces`, batch: false });
  try {
    await withSpan('llm', { 'gen_ai.request.model': '202-555-0143', 'keel.cost_usd': .25 }, () => undefined); await tracing.forceFlush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.includes(Buffer.from('202-555-0143'))).toBe(false);
    expect(bodies[0]!.includes(Buffer.from('keel.cost_usd'))).toBe(true);
  } finally { await tracing.shutdown(); vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
