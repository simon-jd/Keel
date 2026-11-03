import { inspect } from 'node:util';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { BatchSpanProcessor, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';
import { createPrivacyExporter } from '../src/exporter.js';

const sentinel = 'fixture-alice@example.com fixture-private-token';
function privateError(): Error {
  const error = Object.assign(new Error(sentinel, { cause: { credential: sentinel } }), { name: sentinel, detail: sentinel });
  error.stack = `fixture private stack: ${sentinel}`;
  return error;
}
function captureDiagnostics() {
  const errors: unknown[][] = [];
  diag.setLogger({ error: (...args) => { errors.push(args); }, warn() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.ERROR);
  return errors;
}
const rejection = (work: () => Promise<void>) => Promise.resolve().then(work).then(() => undefined, (error: unknown) => error);

// Break: forwarding callback errors or sync throws leaks raw exporter data into real SDK diagnostics and flush rejections.
test.each([
  { processor: 'simple', boundary: 'callback' }, { processor: 'simple', boundary: 'async-callback' }, { processor: 'simple', boundary: 'throw' },
  { processor: 'batch', boundary: 'callback' }, { processor: 'batch', boundary: 'async-callback' }, { processor: 'batch', boundary: 'throw' },
] as const)('exporter $boundary failure stays failed and private through real $processor SDK', async ({ processor, boundary }) => {
  const errors = captureDiagnostics();
  const exporter = createPrivacyExporter({ export(_spans, callback) { if (boundary === 'throw') throw privateError(); if (boundary === 'async-callback') queueMicrotask(() => callback({ code: 1, error: privateError() })); else callback({ code: 1, error: privateError() }); }, async shutdown() {} });
  const provider = new TracerProvider({ spanProcessors: [processor === 'simple' ? new SimpleSpanProcessor({ exporter }) : new BatchSpanProcessor({ exporter })] });
  try {
    // End synchronously and immediately flush so the SDK must surface the pending export failure.
    provider.getTracer('keel').startSpan('llm').end();
    const failure = await rejection(() => provider.forceFlush());
    expect(failure).toBeDefined();
    if (processor === 'simple') expect(errors.length).toBeGreaterThan(0);
    expect(inspect({ errors, failure }, { depth: 8 })).not.toMatch(/fixture-alice@example\.com|fixture-private-token|fixture private stack/);
    const safeError = (Array.isArray(failure) ? failure[0] : failure) as Error & { detail?: unknown };
    expect(safeError).toBeInstanceOf(Error);
    expect(safeError.message).toBe('TRACE_EXPORT_FAILED');
    expect(safeError.stack).toBeUndefined();
    expect(safeError.cause).toBeUndefined();
    expect(safeError.detail).toBeUndefined();
    expect(inspect(failure, { depth: 8 })).toContain('TRACE_EXPORT_FAILED');
  } finally { await provider.shutdown(); diag.disable(); }
});

// Break: optional lifecycle methods can reject OR throw before returning a promise, carrying raw error fields.
test.each([
  { operation: 'forceFlush', boundary: 'reject' }, { operation: 'forceFlush', boundary: 'throw' },
  { operation: 'shutdown', boundary: 'reject' }, { operation: 'shutdown', boundary: 'throw' },
] as const)('$operation $boundary preserves a sanitized rejection through the real SDK', async ({ operation, boundary }) => {
  const errors = captureDiagnostics();
  const fail = (): Promise<void> => { if (boundary === 'throw') throw privateError(); return Promise.reject(privateError()); };
  const exporter: SpanExporter = { export(_spans, callback) { callback({ code: 0 }); }, shutdown: operation === 'shutdown' ? fail : async () => {}, ...(operation === 'forceFlush' ? { forceFlush: fail } : {}) };
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: createPrivacyExporter(exporter) })] });
  try {
    const failure = await rejection(() => provider[operation]());
    expect(failure).toBeDefined();
    expect(inspect({ errors, failure }, { depth: 8 })).not.toMatch(/fixture-alice@example\.com|fixture-private-token|fixture private stack/);
    const safeError = (Array.isArray(failure) ? failure[0] : failure) as Error & { detail?: unknown };
    expect(safeError).toBeInstanceOf(Error);
    expect(safeError.message).toBe('TRACE_EXPORT_FAILED');
    expect(safeError.stack).toBeUndefined();
    expect(safeError.cause).toBeUndefined();
    expect(safeError.detail).toBeUndefined();
    expect(inspect(failure, { depth: 8 })).toContain('TRACE_EXPORT_FAILED');
  } finally { if (operation !== 'shutdown') await provider.shutdown(); diag.disable(); }
});
