/** Actual service benchmark. It rewrites docs/evidence/pii-overhead.json, so it only runs with
 * KEEL_MEASURE_PII_OVERHEAD=1 under scripts/with_pii_sidecar.py (`make measure-pii-overhead`). */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { BatchSpanProcessor, InMemorySpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';
import { createPrivacyExporter } from '../src/exporter.js';
import { createPiiExporter } from '../src/piiProcessor.js';

// An actual monotonic comparison of the same SDK+projection path, differing only in the PII stage.
test.skipIf(process.env.KEEL_MEASURE_PII_OVERHEAD !== '1')('measures real Presidio HTTP overhead through paired actual SDK batches', async () => {
  const endpoint = process.env.KEEL_TEST_PII_ENDPOINT;
  if (!endpoint) throw new Error('ADMITTED_REAL_PRESIDIO_HTTP_REQUIRED');
  const root = resolve(import.meta.dirname, '../../..');
  const paths = ['services/pii/app.py', 'services/pii/requirements.lock', 'scripts/with_pii_sidecar.py',
    'packages/tracing/src/span.ts', 'packages/tracing/src/exporter.ts', 'packages/tracing/src/piiProcessor.ts', 'packages/tracing/src/otlpExporter.ts',
    'packages/tracing/test/pii-overhead.test.ts', 'packages/tracing/package.json', 'pnpm-lock.yaml'];
  const require = createRequire(import.meta.url);
  const installedVersion = (name: string): string => {
    let directory = dirname(require.resolve(name));
    // Resolve actual installed package metadata without relying on a hardcoded package-store path.
    while (directory !== dirname(directory)) {
      try {
        const metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (metadata.name === name && metadata.version) return metadata.version;
      } catch { /* Ancestor is not the owning package. */ }
      directory = dirname(directory);
    }
    throw new Error('INSTALLED_PACKAGE_METADATA_UNAVAILABLE');
  };
  const versions = { node: process.version, sdk_trace: installedVersion('@opentelemetry/sdk-trace'), otlp_base: installedVersion('@opentelemetry/otlp-exporter-base'), otlp_transformer: installedVersion('@opentelemetry/otlp-transformer'), service: JSON.parse(process.env.KEEL_PII_SERVICE_VERSIONS ?? '{}') };
  const sourceHashes = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  const sourceBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0;
  function pipeline(protectedPath: boolean) {
    const sink = new InMemorySpanExporter();
    const exporter = protectedPath ? createPrivacyExporter(createPiiExporter(createPrivacyExporter(sink), { endpoint: endpoint! })) : createPrivacyExporter(sink);
    const provider = new TracerProvider({ spanProcessors: [new BatchSpanProcessor({ exporter, maxExportBatchSize: 32 })] });
    return { sink, provider, tracer: provider.getTracer('keel') };
  }
  const baseline = pipeline(false); const protectedPath = pipeline(true);
  const warmup = 10; const samples = 100; const batchSize = 16;
  let expectedClean = 0; let observedClean = 0; let exported = 0;
  async function batch(target: ReturnType<typeof pipeline>) {
    const start = performance.now();
    for (let i = 0; i < batchSize; i++) {
      const span = target.tracer.startSpan('llm');
      span.setAttributes({ 'gen_ai.request.model': i % 2 === 0 ? 'qwen3' : '202-555-0143', 'keel.cost_usd': 0 }); span.end();
    }
    await target.provider.forceFlush();
    const elapsed = performance.now() - start;
    const spans = target.sink.getFinishedSpans();
    if (target === protectedPath) {
      expectedClean += batchSize / 2; observedClean += spans.filter(span => span.attributes['gen_ai.request.model'] === 'qwen3').length;
      exported += spans.length;
      expect(spans.some(span => span.attributes['gen_ai.request.model'] === '202-555-0143')).toBe(false);
    }
    target.sink.reset();
    return elapsed;
  }
  const pairs: { baseline_ms: number; protected_ms: number; added_ms: number }[] = [];
  try {
    for (let i = 0; i < warmup + samples; i++) {
      let a: number; let b: number;
      if (i % 2 === 0) { a = await batch(baseline); b = await batch(protectedPath); }
      else { b = await batch(protectedPath); a = await batch(baseline); }
      if (i >= warmup) pairs.push({ baseline_ms: a, protected_ms: b, added_ms: b - a });
      if (i === warmup - 1) { expectedClean = 0; observedClean = 0; exported = 0; }
    }
  } finally { await baseline.provider.shutdown(); await protectedPath.provider.shutdown(); }
  const percentile = (values: number[], quantile: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]!;
  const evidence = {
    at: new Date().toISOString(), source_base: sourceBase, source_dirty: dirty, source_sha256: sourceHashes,
    scope: 'actual local Presidio HTTP + actual SDK BatchSpanProcessor + privacy projection + in-memory sink; no Langfuse/model/backend proof',
    clock: 'node:perf_hooks performance.now monotonic; paired alternating execution order',
    warmup_pairs: warmup, measured_pairs: samples, spans_per_batch: batchSize, concurrency: 1, pii_deadline_ms: 200,
    input: '8 clean model identifiers and 8 reserved US phone model identifiers per batch; no prompt collection',
    hardware: { cpu: cpus()[0]?.model, logical_cpus: cpus().length, platform: platform(), release: release(), total_memory_bytes: totalmem() },
    versions,
    results: { baseline_p95_ms: percentile(pairs.map(p => p.baseline_ms), .95), protected_p95_ms: percentile(pairs.map(p => p.protected_ms), .95), paired_added_p50_ms: percentile(pairs.map(p => p.added_ms), .5), paired_added_p95_ms: percentile(pairs.map(p => p.added_ms), .95), expected_clean_attributes: expectedClean, observed_clean_attributes: observedClean, clean_attribute_drop_fraction: 1 - observedClean / expectedClean, exported_spans: exported, expected_spans: samples * batchSize, span_drop_fraction: 1 - exported / (samples * batchSize), node_peak_rss_bytes: process.resourceUsage().maxRSS * 1024 },
    pairs,
  };
  writeFileSync(resolve(root, 'docs/evidence/pii-overhead.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ source_base: sourceBase, source_dirty: dirty, results: evidence.results }));
  expect(pairs).toHaveLength(samples);
  expect(exported).toBe(samples * batchSize);
});
