import { expect, test } from 'vitest';
import { configureTracing } from 'tracing/exporter';
import { withSpan } from 'tracing/span';
import { canaryCase, recordingExporter, scenarioTools } from '../src/langfuseRun.js';

type Sink = Parameters<typeof recordingExporter>[0];

// Break: recording before the sink acknowledges, or dropping the spans, loses the sent-vs-stored baseline.
test('recording exporter logs each final span with its acknowledgement and still delivers it', async () => {
  const delivered: unknown[] = [];
  const sink: Sink = { export(spans, callback) { delivered.push(...spans); callback({ code: 0 }); }, async shutdown() {} };
  const log: Record<string, unknown>[] = [];
  const tracing = configureTracing({ exporter: recordingExporter(sink, row => log.push(row)), batch: false });
  try {
    await withSpan('llm', { 'keel.cost_usd': 0.25, prompt: 'dana@example.com' }, () => undefined);
    await tracing.forceFlush();
  } finally { await tracing.shutdown(); }
  expect(delivered).toHaveLength(1);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ name: 'llm', ok: true, attributes: { 'keel.cost_usd': 0.25, 'gen_ai.operation.name': 'chat' } });
  expect(log[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(log[0]!.ackMs as number).toBeGreaterThanOrEqual(log[0]!.endMs as number);
  expect(JSON.stringify(log)).not.toContain('dana@example.com');
});

// Break: canaries that repeat across runs, or tools that never return the PII, make the leak sweep vacuous.
test('each case carries distinct raw PII in the task and in tool results', async () => {
  const a = canaryCase(0); const b = canaryCase(1);
  expect(a.canaries).not.toEqual(b.canaries);
  expect(a.canaries).toContain(a.injectedPhone);
  for (const canary of a.canaries.filter(x => x !== a.injectedPhone)) expect(a.input + JSON.stringify(a.record)).toContain(canary);
  const lookup = scenarioTools(a).find(t => t.name === 'customer.lookup')!;
  expect(JSON.stringify(await lookup.run({ email: a.record.email }, {} as never))).toContain(a.record.phone);
  expect(scenarioTools(a).every(t => !t.sideEffect)).toBe(true);
});
