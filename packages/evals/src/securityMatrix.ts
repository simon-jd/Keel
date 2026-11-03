import { readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, canonical } from '../../runtime/src/actions.js';
import { benchmarkPolicy, policies } from '../../guard/src/benchmarkPolicy.js';
import type { Defense, BenchmarkHost } from '../../guard/src/benchmarkPolicy.js';
import { runControlledScenario } from '../../guard/attacks/controlled.js';
import { attackScenarios } from '../../guard/attacks/scenarios.js';
import type { ModelClient } from '../../models/src/types.js';
export { policies };
export type SecurityJob = { jobId: string; caseId: string; model: string; policy: Defense; benchmark: 'controlled' | 'agentdojo' | 'tau2'; kind: 'attack' | 'clean'; binding: string };
export type SecurityRow = SecurityJob & { manifestHash: string; runId: string; status: 'completed' | 'failed' | 'invalid' | 'incomplete' | 'blocked'; attackSuccess: boolean | null; utility: number | null; latencyMs: number | null; calls: number; generationIds: string[]; knownCostUsd: number; totalCostUsd: number | null; knownProviderAttempts?: number; totalProviderAttempts?: number | null; providerAttemptUpperBound?: number };
function requireValue(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
const finite = (n: number) => Number.isFinite(n) && n >= 0;
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const admissionCodes = ['BUDGET_DENIED', 'BUDGET_EXHAUSTED', 'MODEL_INPUT_REJECTED'] as const;
function admissionCode(value: unknown): string | null { return typeof value === 'string' && admissionCodes.some(code => code === value) ? value : null; }

/** Every planned cell survives partial execution. Bounds include all unknown
 * outcomes; only original scorer observations contribute to evaluable rates. */
export function securityMatrixAggregates(manifest: { bindingHash: string; jobs: SecurityJob[] }, rows: SecurityRow[]) {
  const jobs = new Map(manifest.jobs.map(job => [job.jobId, job]));
  requireValue(jobs.size === manifest.jobs.length && jobs.size > 0, 'INVALID_MATRIX_JOBS');
  const population = new Map<string, SecurityJob[]>();
  for (const job of jobs.values()) {
    requireValue(policies.includes(job.policy) && ['attack', 'clean'].includes(job.kind), 'INVALID_MATRIX_POLICY');
    const key = canonical([job.caseId, job.model]);
    population.set(key, [...(population.get(key) ?? []), job]);
  }
  for (const group of population.values()) requireValue(group.length === policies.length && new Set(group.map(j => j.policy)).size === policies.length
    && group.every(j => j.binding === group[0]!.binding && j.kind === group[0]!.kind && j.benchmark === group[0]!.benchmark), 'MATRIX_POPULATION_DRIFT');
  const byId = new Map<string, SecurityRow>(); const runs = new Set<string>(); const generations = new Set<string>();
  for (const row of rows) {
    const job = jobs.get(row.jobId);
    requireValue(job && Object.entries(job).every(([key, value]) => row[key as keyof SecurityRow] === value)
      && row.manifestHash === manifest.bindingHash && !byId.has(row.jobId) && row.runId && !runs.has(row.runId), 'RESULT_BINDING_DRIFT');
    requireValue(['completed', 'failed', 'invalid', 'incomplete', 'blocked'].includes(row.status)
      && (row.attackSuccess === null || typeof row.attackSuccess === 'boolean')
      && (row.utility === null || finite(row.utility) && row.utility <= 1)
      && (row.latencyMs === null || finite(row.latencyMs)) && finite(row.knownCostUsd)
      && (row.totalCostUsd === null || finite(row.totalCostUsd) && row.totalCostUsd === row.knownCostUsd)
      && Number.isSafeInteger(row.calls) && row.calls >= 0 && row.generationIds.length === row.calls, 'INVALID_MATRIX_RESULT');
    requireValue((job.kind === 'attack' || row.attackSuccess === null) && (job.kind === 'clean' || row.utility === null)
      && (!['invalid', 'incomplete'].includes(row.status) || row.attackSuccess === null && row.utility === null)
      && (row.status !== 'failed' || row.attackSuccess !== false && row.utility === null)
      && (row.status !== 'completed' || (job.kind === 'attack' ? row.attackSuccess !== null : row.utility !== null)), 'INVALID_MATRIX_SCORE');
    if (row.knownProviderAttempts !== undefined) requireValue(Number.isSafeInteger(row.knownProviderAttempts) && row.knownProviderAttempts >= 0
      && row.knownProviderAttempts <= row.calls * 5 && (row.totalProviderAttempts === null || row.totalProviderAttempts === row.knownProviderAttempts)
      && row.providerAttemptUpperBound !== undefined && Number.isSafeInteger(row.providerAttemptUpperBound)
      && row.providerAttemptUpperBound >= row.knownProviderAttempts && row.providerAttemptUpperBound <= row.calls * 5, 'INVALID_PROVIDER_ATTEMPTS');
    for (const id of row.generationIds) { requireValue(id && !generations.has(id), 'REUSED_MODEL_GENERATION'); generations.add(id); }
    byId.set(row.jobId, row); runs.add(row.runId);
  }
  const metric = (group: SecurityJob[], kind: 'attack' | 'clean') => {
    const planned = group.filter(j => j.kind === kind);
    const values = planned.map(j => { const r = byId.get(j.jobId); return kind === 'attack' ? r?.attackSuccess == null ? null : Number(r.attackSuccess) : r?.utility ?? null; });
    const known = values.filter((v): v is number => v !== null); const success = known.reduce((a, b) => a + b, 0);
    return { planned: planned.length, evaluable: known.length, success, rate: known.length ? success / known.length : null,
      lower: planned.length ? success / planned.length : null, upper: planned.length ? (success + planned.length - known.length) / planned.length : null };
  };
  const models = [...new Set(manifest.jobs.map(j => j.model))];
  const cells = models.flatMap(model => policies.map(policy => {
    const group = manifest.jobs.filter(j => j.model === model && j.policy === policy);
    const actual = group.flatMap(j => byId.has(j.jobId) ? [byId.get(j.jobId)!] : []);
    const latency: number[] = []; const cost: number[] = [];
    if (policy !== 'none') for (const job of group) {
      const row = byId.get(job.jobId); const baseline = manifest.jobs.find(j => j.model === model && j.caseId === job.caseId && j.policy === 'none');
      const base = baseline && byId.get(baseline.jobId);
      if (row?.status === 'completed' && base?.status === 'completed') {
        if (row.latencyMs !== null && base.latencyMs !== null) latency.push(row.latencyMs - base.latencyMs);
        if (row.totalCostUsd !== null && base.totalCostUsd !== null) cost.push(row.totalCostUsd - base.totalCostUsd);
      }
    }
    const knownCostUsd = actual.reduce((sum, row) => sum + row.knownCostUsd, 0);
    return { model, policy, planned: group.length, observed: actual.length,
      statuses: Object.fromEntries(['completed', 'failed', 'invalid', 'incomplete', 'blocked', 'not_attempted'].map(status => [status, status === 'not_attempted' ? group.length - actual.length : actual.filter(r => r.status === status).length])),
      attack: metric(group, 'attack'), utility: metric(group, 'clean'),
      byBenchmark: Object.fromEntries(['agentdojo', 'controlled', 'tau2'].map(benchmark => [benchmark, { attack: metric(group.filter(j => j.benchmark === benchmark), 'attack'), utility: metric(group.filter(j => j.benchmark === benchmark), 'clean') }])),
      calls: actual.reduce((sum, row) => sum + row.calls, 0), knownCostUsd,
      knownProviderAttempts: actual.reduce((sum, row) => sum + (row.knownProviderAttempts ?? 0), 0),
      totalProviderAttempts: actual.length === group.length && actual.every(row => row.totalProviderAttempts !== null && row.totalProviderAttempts !== undefined)
        ? actual.reduce((sum, row) => sum + row.totalProviderAttempts!, 0) : null,
      providerAttemptUpperBound: actual.reduce((sum, row) => sum + (row.providerAttemptUpperBound ?? row.calls * 5), 0),
      totalCostUsd: actual.length === group.length && actual.every(r => r.totalCostUsd !== null) ? knownCostUsd : null,
      overhead: { planned: policy === 'none' ? 0 : group.length, latencyPairs: latency.length, meanExtraLatencyMs: mean(latency), costPairs: cost.length, meanExtraCostUsd: mean(cost) } };
  }));
  const coverageComplete = models.every(model => [['agentdojo', 'attack'], ['agentdojo', 'clean'], ['controlled', 'attack'], ['controlled', 'clean'], ['tau2', 'clean']]
    .every(([benchmark, kind]) => manifest.jobs.some(j => j.model === model && j.benchmark === benchmark && j.kind === kind)));
  const executionComplete = rows.length === jobs.size && rows.every(r => r.status === 'completed');
  return { complete: executionComplete && coverageComplete, executionComplete, coverageComplete, planned: jobs.size, observed: rows.length, cells };
}

export async function runControlledDefense(options: { scenarioId: string; injected: boolean; model: ModelClient; modelAlias: string; seed: number; runId: string; policy: Defense; host: BenchmarkHost }) {
  const scenario = attackScenarios.find(s => s.id === options.scenarioId);
  requireValue(scenario, 'UNKNOWN_CONTROLLED_CASE');
  const guard = benchmarkPolicy(options.policy, options.host); let state = guard.initialize(); let seq = 0;
  let blocked: string | null = null;
  let admissionStop: string | null = null;
  const observedModel: ModelClient = { async *stream(request, streamOptions) {
    try { yield* options.model.stream(request, streamOptions); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error) admissionStop = admissionCode(error.code);
      throw error;
    }
  } };
  const result = await runControlledScenario({ ...options, model: observedModel, scenario, trustedGuard: {
    dispatch(request) {
      const decision = guard.evaluate({ tenantId: 'virtual-matrix', runId: options.runId, tool: request.tool,
        args: request.args, argsHash: hash(request.args), actionKey: hash([options.runId, seq++, request.tool, request.args]),
        capabilities: options.host.capabilities, sideEffect: options.host.tools[request.tool]?.sideEffect ?? true }, state);
      if (decision !== 'allow') { blocked = decision; throw Error('HOST_DENIED'); }
    }, observe() { state = guard.observe(state); },
  } });
  const concluded = result.status === 'completed' || blocked !== null;
  return { ...result, attackSuccess: result.attackSuccess ? true : concluded ? false : null,
    utility: concluded ? result.utility : null, admissionStop, blocked, policyHash: guard.policyHash };
}

/** Local Keel backend transport only; the backend owns packages/models routing,
 * generation accounting and trace. There is no provider SDK in this process. */
function backendModel(endpoint: string, token: string, limit: number, journal: string) {
  const url = new URL(endpoint);
  requireValue(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port === '18080' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash && token, 'INVALID_KEEL_ENDPOINT');
  requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000 && journal, 'INVALID_REQUEST_LIMIT');
  const transport: { calls: number; records: { accounting: unknown; request: unknown; response?: unknown }[]; generationIds: string[] } = { calls: 0, records: [], generationIds: [] };
  const persist = () => { const temporary = journal + '.pending'; const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(transport)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, journal); };
  const model: ModelClient = { async *stream(request, options) {
    requireValue(transport.calls < limit, 'MATRIX_REQUEST_LIMIT');
    const size = (path: string): number => statSync(path).isDirectory() ? readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0) : statSync(path).size;
    requireValue(size(dirname(dirname(journal))) + Buffer.byteLength(JSON.stringify(transport)) + Buffer.byteLength(JSON.stringify(request)) + 4_000_000 <= 16_000_000, 'MATRIX_EVIDENCE_LIMIT');
    const payload = { ...request, run_id: options.run_id, call_id: options.call_id };
    const record: typeof transport.records[number] = { accounting: null, request: payload };
    transport.calls++; transport.records.push(record); transport.generationIds.push(options.call_id!); persist();
    const response = await fetch(new URL('v1/agent/step', url), { method: 'POST', redirect: 'error', signal: options.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload) });
    const reader = response.body?.getReader(); requireValue(reader, 'KEEL_RESPONSE_MISSING');
    let raw = ''; let bytes = 0; const decoder = new TextDecoder();
    try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength;
      requireValue(bytes <= 2_000_000, 'KEEL_RESPONSE_LIMIT'); raw += decoder.decode(item.value, { stream: true }); } }
    finally { await reader.cancel(); }
    const value = JSON.parse(raw + decoder.decode());
    record.accounting = value.accounting ?? null; record.response = value; persist();
    if (!response.ok) throw Object.assign(Error('KEEL_REQUEST_FAILED'), { accounting: value.accounting,
      ...(admissionCode(value.error) ? { code: admissionCode(value.error) } : {}) });
    requireValue(value.run_id === options.run_id && value.call_id === options.call_id, 'KEEL_RESPONSE_BINDING_DRIFT');
    requireValue(value.action && typeof value.action === 'object', 'KEEL_INVALID_RESPONSE');
    yield { ...(value.action.content !== undefined ? { text: value.action.content } : {}),
      ...(value.action.toolCalls ? { toolCalls: value.action.toolCalls } : {}),
      ...(value.invalidToolCalls ? { invalidToolCalls: value.invalidToolCalls } : {}),
      ...(value.accounting ? { accounting: value.accounting } : {}), ...(value.usage ? { usage: value.usage } : {}) };
  } };
  return { model, transport };
}
async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (process.argv[2] === 'describe') process.stdout.write(JSON.stringify(attackScenarios));
  else if (process.argv[2] === 'aggregate') process.stdout.write(JSON.stringify(securityMatrixAggregates(input.manifest, input.rows)));
  else if (process.argv[2] === 'controlled') {
    const token = process.env.KEEL_SECURITY_TOKEN ?? '';
    const backend = backendModel(input.endpoint, token, input.maxRequests, input.journal);
    process.stdout.write(JSON.stringify({ ...await runControlledDefense({ ...input, model: backend.model }), transport: backend.transport }));
  } else throw Error('INVALID_SECURITY_COMMAND');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('SECURITY_MATRIX_FAILED\n'); process.exitCode = 1; });
