import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';
import { createPiiExporter } from '../src/piiProcessor.js';
import { createPrivacyExporter, configureTracing } from '../src/exporter.js';
import { withSpan } from '../src/span.js';

type Item = { id: string; text: string };
const phone = '202-555-0143';
const email = 'audit@example.com';
async function fixture(handler: (items: Item[], res: ServerResponse, req: IncomingMessage) => void) {
  const requests: Item[][] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { items } = JSON.parse(Buffer.concat(chunks).toString()) as { items: Item[] };
    requests.push(items); res.setHeader('content-type', 'application/json'); handler(items, res, req);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_BIND_FAILED');
  return { endpoint: `http://127.0.0.1:${address.port}/redact`, requests,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function setup(endpoint: string, batch = false) {
  const sink = new InMemorySpanExporter();
  const original = new InMemorySpanExporter();
  const exporter = createPrivacyExporter(createPiiExporter(createPrivacyExporter(sink), { endpoint }));
  const provider = new TracerProvider({ spanProcessors: [batch ? new BatchSpanProcessor({ exporter }) : new SimpleSpanProcessor({ exporter }), new SimpleSpanProcessor({ exporter: original })] });
  return { sink, original, provider, tracer: provider.getTracer('private-scope') };
}
function hostile(tracer: ReturnType<typeof setup>['tracer']) {
  const span = tracer.startSpan(email);
  span.setAttributes({ 'gen_ai.request.model': phone, prompt: `${email} +1 ${phone}`, token: 'private-canary', 'keel.cost_usd': .25 });
  span.addEvent(email); span.setStatus({ code: 2, message: email }); span.end();
}
const json = (res: ServerResponse, items: Item[]) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items })); };

// Break: onEnd cannot let the original span race ahead of asynchronous redaction; clones protect other exporters.
test('awaits batch redaction before export and flush without mutating originals', async () => {
  let release = () => {};
  const seen = new Promise<void>(resolve => { release = resolve; });
  let respond = () => {};
  const http = await fixture((items, res) => { respond = () => json(res, items.map(item => ({ ...item, text: 'qwen3' }))); release(); });
  const { provider, tracer, sink, original } = setup(http.endpoint, true);
  try {
    hostile(tracer); hostile(tracer);
    const flushed = provider.forceFlush();
    await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('NO_PII_REQUEST')), 1000))]);
    expect(sink.getFinishedSpans()).toHaveLength(0);
    respond(); await flushed;
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toHaveLength(2);
    expect(JSON.stringify(http.requests)).not.toMatch(/audit@example.com|private-canary|prompt/);
    expect(sink.getFinishedSpans()).toHaveLength(2);
    expect(sink.getFinishedSpans()[0]!.attributes).toEqual({ 'gen_ai.request.model': 'qwen3', 'keel.cost_usd': .25 });
    expect(original.getFinishedSpans()[0]!.attributes['gen_ai.request.model']).toBe(phone);
    expect(original.getFinishedSpans()[0]!.events[0]!.name).toBe(email);
  } finally { await provider.shutdown(); await http.close(); }
});

// Break: the real Presidio HTTP stage must delete detected phone metadata; email/envelope content is projected out first.
test.skipIf(!process.env.KEEL_TEST_PII_ENDPOINT)('emailAndPhoneRedactedInExportedSpans', async () => {
  const endpoint = process.env.KEEL_TEST_PII_ENDPOINT;
  if (!endpoint) throw new Error('REAL_PRESIDIO_HTTP_REQUIRED: run via scripts/with_pii_sidecar.py');
  const { provider, tracer, sink, original } = setup(endpoint);
  try {
    hostile(tracer);
    const clean = tracer.startSpan('llm'); clean.setAttribute('gen_ai.request.model', 'qwen3'); clean.end();
    await provider.forceFlush();
    const exported = sink.getFinishedSpans();
    expect(exported).toHaveLength(2);
    expect(exported[0]!.attributes).toEqual({ 'keel.cost_usd': .25 });
    expect(exported[1]!.attributes['gen_ai.request.model']).toBe('qwen3');
    const envelope = exported.map(span => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status, links: span.links, resource: span.resource.attributes, scope: span.instrumentationScope, context: span.spanContext() }));
    expect(JSON.stringify(envelope)).not.toMatch(/audit@example.com|202-555-0143|private-canary|private-scope/);
    expect(original.getFinishedSpans()[0]!.attributes['gen_ai.request.model']).toBe(phone);
  } finally { await provider.shutdown(); }
});

// Break: failed/uncorrelated HTTP responses must never restore the original string, including late completion after shutdown.
test.each(['timeout', 'reordered', 'missing', 'duplicate', 'wrongfield', 'malformed', 'non2xx', 'exception', 'truncated', 'oversize'] as const)('timeoutDropsAttributesNotRaw: %s', async mode => {
  let late: ReturnType<typeof setTimeout> | undefined;
  const http = await fixture((items, res, req) => {
    if (mode === 'timeout') { late = setTimeout(() => json(res, items), 450); return; }
    if (mode === 'reordered') { json(res, [...items].reverse()); return; }
    if (mode === 'missing') { json(res, []); return; }
    if (mode === 'duplicate') { json(res, [items[0]!, items[0]!]); return; }
    if (mode === 'wrongfield') { res.end(JSON.stringify({ items: items.map(item => ({ id: item.id, value: item.text })) })); return; }
    if (mode === 'malformed') { res.end('{'); return; }
    if (mode === 'non2xx') { res.writeHead(503); res.end(email); return; }
    if (mode === 'exception') { req.socket.destroy(); return; }
    if (mode === 'truncated') { res.writeHead(200, { 'content-length': 1000 }); res.write('{'); res.destroy(); return; }
    res.end('x'.repeat(65537));
  });
  const { provider, tracer, sink } = setup(http.endpoint);
  try {
    const started = performance.now();
    const span = tracer.startSpan('llm'); span.setAttributes({ 'gen_ai.request.model': phone, 'gen_ai.system': 'openai', 'keel.cost_usd': .25 }); span.end();
    await provider.forceFlush();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(sink.getFinishedSpans()).toHaveLength(1);
    expect(sink.getFinishedSpans()[0]!.attributes).toEqual({ 'keel.cost_usd': .25 });
  } finally { await provider.shutdown(); if (late) clearTimeout(late); await http.close(); }
});

// Break: shutdown may not close the sink while a pre-export request is pending or deliver a late original span.
test('shutdown waits for the bounded pre-export request and callbacks settle once', async () => {
  const http = await fixture(() => {});
  let calls = 0; let closed = false; const attributes: unknown[] = [];
  const sink: SpanExporter = { export(spans, cb) { expect(closed).toBe(false); calls++; attributes.push(spans[0]!.attributes); cb({ code: 0 }); cb({ code: 0 }); }, async shutdown() { closed = true; } };
  const exporter = createPrivacyExporter(createPiiExporter(createPrivacyExporter(sink), { endpoint: http.endpoint }));
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  try {
    const span = provider.getTracer('keel').startSpan('llm'); span.setAttribute('gen_ai.request.model', phone); span.end();
    await provider.shutdown();
    expect(closed).toBe(true); expect(calls).toBe(1); expect(attributes).toEqual([{}]);
  } finally { await http.close(); }
});

// Break: raw text must never be routed to a model-controlled remote endpoint.
test.each(['https://example.com/redact', 'http://localhost/redact', 'http://127.0.0.1/redact?token=x', 'http://user:secret@127.0.0.1/redact', 'http://127.0.0.1/wrong'])('rejects non-fixed-loopback PII endpoint %#', endpoint => {
  expect(() => createPiiExporter(new InMemorySpanExporter(), { endpoint })).toThrow('INVALID_PII_ENDPOINT');
});

// Break: the supported configureTracing SDK path must include the awaited PII stage.
test('configureTracing opts into the real pre-export PII stage without collecting prompts', async () => {
  const http = await fixture((items, res) => json(res, items.map(item => ({ ...item, text: '[REDACTED]' }))));
  const sink = new InMemorySpanExporter();
  const tracing = configureTracing({ exporter: sink, piiEndpoint: http.endpoint, batch: true });
  try {
    await withSpan('llm', { 'gen_ai.request.model': phone, prompt: email }, () => undefined);
    await tracing.forceFlush();
    expect(http.requests).toHaveLength(1);
    expect(JSON.stringify(http.requests)).not.toContain(email);
    expect(sink.getFinishedSpans()[0]!.attributes).toEqual({});
  } finally { await tracing.shutdown(); await http.close(); }
});

// Break: oversized SDK batches must fail closed before sending text to the service.
test('oversized metadata batches omit strings while preserving numeric metrics', async () => {
  const http = await fixture((items, res) => json(res, items));
  const { provider, tracer, sink } = setup(http.endpoint, true);
  try {
    for (let i = 0; i < 129; i++) {
      const span = tracer.startSpan('llm'); span.setAttributes({ 'gen_ai.request.model': phone, 'keel.cost_usd': 0 }); span.end();
    }
    await provider.forceFlush();
    expect(http.requests).toHaveLength(0);
    expect(sink.getFinishedSpans()).toHaveLength(129);
    expect(sink.getFinishedSpans().every(span => span.attributes['gen_ai.request.model'] === undefined && span.attributes['keel.cost_usd'] === 0)).toBe(true);
  } finally { await provider.shutdown(); await http.close(); }
});

// Break: SimpleSpanProcessor.shutdown delegates directly; our stage must await an asynchronous sink callback too.
test('shutdown drains the downstream callback before closing the sink', async () => {
  const http = await fixture((items, res) => json(res, items));
  let delivered = false; let closedAfterDelivery = false;
  const sink: SpanExporter = { export(_spans, callback) { setTimeout(() => { delivered = true; callback({ code: 0 }); }, 30); }, async shutdown() { closedAfterDelivery = delivered; } };
  const exporter = createPrivacyExporter(createPiiExporter(createPrivacyExporter(sink), { endpoint: http.endpoint }));
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  try {
    const span = provider.getTracer('keel').startSpan('llm'); span.setAttribute('gen_ai.request.model', 'qwen3'); span.end();
    await provider.shutdown();
    expect(closedAfterDelivery).toBe(true);
    expect(delivered).toBe(true);
  } finally { await http.close(); }
});
