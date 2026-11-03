/**
 * Task 4 local Langfuse ingestion: real runAgent runs on the local vLLM backend, traced through the
 * production exporter chain (privacy projection -> Presidio stage -> OTLP) to the compose collector.
 * Every task and tool result carries synthetic raw PII so the Langfuse side can be swept for leaks.
 *
 *   tsx packages/runtime/src/langfuseRun.ts run SPEC.json OUT_DIR
 * Env: KEEL_LANGFUSE_PG_URL (compose Keel Postgres), KEEL_TEST_PII_ENDPOINT (scripts/with_pii_sidecar.py),
 *      KEEL_VLLM_TOKEN_FILE (local_batch.py). Run only via local_batch.py --langfuse under scripts/gpu_run.py.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { z } from 'zod';
import { createRouter } from 'models/router';
import { configureTracing } from 'tracing/exporter';
import { withSpan } from 'tracing/span';
import { createSafeOtlpExporter } from '../../tracing/src/otlpExporter.js';
import { runAgent } from './loop.js';
import { PostgresStore } from './store.js';
import { defineTool } from './tools.js';
import type { Tool } from './tools.js';

type Exporter = NonNullable<NonNullable<Parameters<typeof configureTracing>[0]>['exporter']>;
export type SentSpan = { spanId: string; traceId: string; parentSpanId: string | null; name: string; endMs: number; exportMs: number; ackMs: number; ok: boolean; attributes: Record<string, unknown> };
const OTLP = 'http://127.0.0.1:14318/v1/traces';
const hrMs = ([seconds, nanos]: [number, number]) => seconds * 1000 + nanos / 1e6;
// Same clock as OTel span times (timeOrigin + monotonic), so ack - end is never negative from rounding.
const nowMs = () => performance.timeOrigin + performance.now();

/** Innermost sink wrapper: records exactly what leaves the process, and when the collector acknowledged it. */
export function recordingExporter(sink: Exporter, record: (row: SentSpan) => void): Exporter {
  return {
    export(spans, callback) {
      const exportMs = nowMs();
      const rows = spans.map(span => ({ spanId: span.spanContext().spanId, traceId: span.spanContext().traceId,
        parentSpanId: span.parentSpanContext?.spanId ?? null, name: span.name, endMs: hrMs(span.endTime), exportMs, attributes: { ...span.attributes } }));
      sink.export(spans, result => {
        const ackMs = nowMs();
        for (const row of rows) record({ ...row, ackMs, ok: result.code === 0 });
        callback(result);
      });
    },
    shutdown: () => sink.shutdown(),
    forceFlush: async () => { await sink.forceFlush?.(); },
  };
}

const people = [['Dana', 'Whitfield'], ['Marcus', 'Okafor'], ['Priya', 'Raman'], ['Elena', 'Petrova'], ['Tomas', 'Lindqvist'],
  ['Aisha', 'Bello'], ['Kenji', 'Mori'], ['Grace', 'Halloran'], ['Luis', 'Carrasco'], ['Noor', 'Haddad']] as const;
export type CanaryCase = ReturnType<typeof canaryCase>;
/** Synthetic people (example.com, 555 numbers). The injected-attribute phone exercises the Presidio stage itself. */
export function canaryCase(index: number) {
  const [first, last] = people[index % people.length]!; const n = String(index).padStart(2, '0');
  const record = { name: `${first} ${last}`, email: `${first.toLowerCase()}.${last.toLowerCase()}.${n}@example.com`,
    phone: `617-555-01${n}`, address: `${100 + index} Beacon Street, Boston, MA 02116`, order: `A${1000 + index}` };
  const injectedPhone = `415-555-02${n}`;
  const input = `Customer ${record.name} (email ${record.email}, phone ${record.phone}) reports that order ${record.order} arrived damaged. `
    + 'Use customer.lookup with their email, order.get for the order and policy.search for the damaged-item policy, then reply with the next step in one sentence.';
  return { index, input, record, injectedPhone, canaries: [record.email, record.phone, record.name, record.address, injectedPhone] };
}

export function scenarioTools(c: CanaryCase): Tool[] {
  return [
    defineTool({ name: 'customer.lookup', sideEffect: false, schema: z.object({ email: z.string() }),
      run: async ({ email }) => email.toLowerCase() === c.record.email ? { found: true, ...c.record, tier: 'standard' } : { found: false } }),
    defineTool({ name: 'order.get', sideEffect: false, schema: z.object({ order: z.string() }),
      run: async ({ order }) => order.toUpperCase() === c.record.order ? { order: c.record.order, status: 'delivered', shipTo: c.record.address, contact: c.record.phone } : { error: 'not_found' } }),
    defineTool({ name: 'policy.search', sideEffect: false, traceKind: 'retrieval', schema: z.object({ query: z.string() }),
      run: async () => ({ results: ['Damaged items: offer a free replacement or a full refund within 30 days of delivery; photos are optional.'] }) }),
  ];
}

const specSchema = z.object({ runs: z.number().int().min(1).max(100), pricing: z.object({ inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative() }).strict() }).strict();

async function migrate(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ t: string | null }>("SELECT to_regclass('public.runs')::text AS t");
    if (!rows[0]?.t) await client.query(readFileSync(new URL('../../db/migrations/0001_initial.up.sql', import.meta.url), 'utf8'));
  } finally { await client.end(); }
}

async function main() {
  const [command, specPath, out] = process.argv.slice(2);
  if (command !== 'run' || !specPath || !out) throw new Error('USAGE');
  const spec = specSchema.parse(JSON.parse(readFileSync(specPath, 'utf8')));
  const pg = process.env.KEEL_LANGFUSE_PG_URL; const pii = process.env.KEEL_TEST_PII_ENDPOINT; const tokenFile = process.env.KEEL_VLLM_TOKEN_FILE;
  if (!pg || !pii || !tokenFile) throw new Error('LANGFUSE_RUN_ENVIRONMENT_REQUIRED');
  mkdirSync(out, { recursive: true });
  await migrate(pg);
  const sentPath = join(out, 'sent.jsonl'); const runsPath = join(out, 'runs.jsonl');
  writeFileSync(sentPath, ''); writeFileSync(runsPath, '');
  const tracing = configureTracing({ exporter: recordingExporter(createSafeOtlpExporter({ url: OTLP, timeoutMillis: 10_000 }), row => appendFileSync(sentPath, JSON.stringify(row) + '\n')), piiEndpoint: pii, batch: true });
  const model = createRouter({ local: { provider: 'openaiCompatible', endpoint: 'http://127.0.0.1:18000/v1', model: 'keel-local', apiKey: readFileSync(tokenFile, 'utf8').trim(), pricing: spec.pricing } });
  const store = new PostgresStore(pg);
  try {
    for (let index = 0; index < spec.runs; index++) {
      const c = canaryCase(index); const runId = randomUUID(); const start = Date.now();
      const result = await runAgent(runId, { tenantId: 'langfuse-ingest', input: c.input, model: 'local', capabilities: ['read'] }, { store, model, tools: scenarioTools(c) });
      // Hostile instrumentation: raw PII offered as a whitelisted string (Presidio must remove it) and as non-whitelisted keys.
      await withSpan('llm', { 'gen_ai.request.model': c.injectedPhone, 'keel.run_id': runId, prompt: c.input, 'user.email': c.record.email }, () => undefined);
      appendFileSync(runsPath, JSON.stringify({ index, runId, status: result.status, errorCode: result.errorCode ?? null, budget: result.budget,
        cost: result.cost ?? null, wallMs: Date.now() - start, outputChars: result.output?.length ?? 0 }) + '\n');
    }
  } finally {
    await tracing.shutdown();
    writeFileSync(join(out, 'done.json'), JSON.stringify({ flushedMs: Date.now(), canaries: Array.from({ length: spec.runs }, (_, i) => canaryCase(i).canaries).flat() }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`LANGFUSE_RUN_FAILED ${error instanceof Error ? error.message : ''}\n`); process.exitCode = 1; });
