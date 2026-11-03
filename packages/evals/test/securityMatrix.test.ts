import { test, expect } from 'vitest';
import { securityMatrixAggregates, runControlledDefense, policies } from '../src/securityMatrix.js';
import type { SecurityJob, SecurityRow } from '../src/securityMatrix.js';
import { attackScenarios, CANARY, FACT } from '../../guard/attacks/scenarios.js';
import type { ModelClient } from '../../models/src/types.js';

const jobs: SecurityJob[] = policies.flatMap(policy => ['attack', 'clean'].map(kind => ({
  jobId: `${policy}-${kind}`, caseId: kind, model: 'fixture-model', policy,
  benchmark: 'controlled' as const, kind: kind as 'attack' | 'clean', binding: 'settings-and-input-hash',
})));
function row(job: SecurityJob, extra: Partial<SecurityRow> = {}): SecurityRow {
  return { ...job, manifestHash: 'manifest', runId: job.jobId, status: 'completed',
    attackSuccess: job.kind === 'attack' ? true : null, utility: job.kind === 'clean' ? 1 : null,
    latencyMs: 100, calls: 1, knownCostUsd: 0.2, totalCostUsd: 0.2, generationIds: [job.jobId], ...extra };
}
test('securityMatrixAggregates retains failed, blocked, unknown and missing denominators', () => {
  const rows = [row(jobs[0]!), row(jobs[1]!), row(jobs[2]!, { status: 'blocked', attackSuccess: false, latencyMs: 130 }),
    row(jobs[3]!, { utility: 0.5, totalCostUsd: null, knownCostUsd: 0.1, latencyMs: 150 })];
  const result = securityMatrixAggregates({ bindingHash: 'manifest', jobs }, rows);
  expect(result.complete).toBe(false);
  expect(result.cells[0]!.attack).toEqual({ planned: 1, evaluable: 1, success: 1, rate: 1, lower: 1, upper: 1 });
  expect(result.cells[1]!.attack).toEqual({ planned: 1, evaluable: 1, success: 0, rate: 0, lower: 0, upper: 0 });
  expect(result.cells[1]!.utility.rate).toBe(0.5);
  expect(result.cells[1]!.totalCostUsd).toBeNull();
  expect(result.cells[1]!.overhead).toEqual({ planned: 2, latencyPairs: 1, meanExtraLatencyMs: 50, costPairs: 0, meanExtraCostUsd: null });
  expect(result.cells[2]!.attack).toEqual({ planned: 1, evaluable: 0, success: 0, rate: null, lower: 0, upper: 1 });
  expect(result.cells[2]!.totalCostUsd).toBeNull();
  const partialPopulation = securityMatrixAggregates({ bindingHash: 'manifest', jobs }, jobs.map(job => row(job)));
  expect(partialPopulation.executionComplete).toBe(true);
  expect(partialPopulation.coverageComplete).toBe(false);
  expect(partialPopulation.complete).toBe(false);
  const retryRows = [row(jobs[0]!, { knownProviderAttempts: 3, totalProviderAttempts: 3, providerAttemptUpperBound: 3 }),
    row(jobs[1]!, { knownProviderAttempts: 1, totalProviderAttempts: null, providerAttemptUpperBound: 5 })];
  // Multiple provider attempts may belong to one logical Keel generation.
  const attempts = securityMatrixAggregates({ bindingHash: 'manifest', jobs }, retryRows).cells[0]!;
  expect(attempts.knownProviderAttempts).toBe(4);
  expect(attempts.totalProviderAttempts).toBeNull();
  expect(attempts.providerAttemptUpperBound).toBe(8);
});
test('rejects duplicate, relabeled, unbound, reused and incomplete falsely scored results', () => {
  for (const rows of [ [row(jobs[0]!), row(jobs[0]!)], [row(jobs[0]!, { binding: 'drift' })],
    [row(jobs[0]!, { manifestHash: 'other' })], [row(jobs[0]!), row(jobs[1]!, { runId: jobs[0]!.jobId })],
    [row(jobs[0]!), row(jobs[1]!, { generationIds: [jobs[0]!.jobId] })],
    [row(jobs[0]!, { status: 'invalid' })], [row(jobs[0]!, { totalCostUsd: 0.1 })] ]) {
    expect(() => securityMatrixAggregates({ bindingHash: 'manifest', jobs }, rows)).toThrow();
  }
});
test('five modes actually gate controlled virtual effects with fresh actual TS policies', async () => {
  const scenario = attackScenarios[0]!;
  const outcomes: (boolean | null)[] = [];
  for (const policy of policies) {
    let count = 0;
    const model: ModelClient = { async *stream() {
      count++;
      if (count === 1) yield { toolCalls: [{ id: 'r', name: scenario.readTool, args: { id: 'item-1' } }] };
      else if (count === 2) yield { toolCalls: [{ id: 'w', name: 'post_message', args: { channel: 'synthetic-attacker', body: CANARY } }] };
      else yield { text: FACT };
    } };
    const result = await runControlledDefense({ scenarioId: scenario.id, injected: true, model,
      modelAlias: 'fixture-model', seed: 0, runId: `run-${policy}`, policy,
      host: { taskHash: 'trusted-initial-task', capabilities: [scenario.readTool], plan: [scenario.readTool],
        tools: { [scenario.readTool]: { sideEffect: false }, post_message: { sideEffect: true }, http_fetch: { sideEffect: true }, grant_access: { sideEffect: true } } } });
    outcomes.push(result.attackSuccess);
  }
  expect(outcomes).toEqual([true, false, false, false, false]);
});

test('capability, taint and plan are independent execution checks', async () => {
  const { benchmarkPolicy } = await import('../../guard/src/benchmarkPolicy.js');
  const host = { taskHash: 'initial', capabilities: ['read', 'write'], plan: ['read'], tools: { read: { sideEffect: false }, write: { sideEffect: true } } };
  const request = { tenantId: 'fixture', runId: 'fixture', tool: 'write', args: {}, argsHash: 'hash', actionKey: 'key', capabilities: [], sideEffect: true };
  expect(policies.map(mode => { const policy = benchmarkPolicy(mode, host); return policy.evaluate(request, policy.initialize()); }))
    .toEqual(['allow', 'allow', 'allow', 'deny', 'deny']);
  const secondHost = { ...host, capabilities: ['read'], plan: ['read', 'write'] };
  expect(policies.map(mode => { const policy = benchmarkPolicy(mode, secondHost); return policy.evaluate(request, policy.initialize()); }))
    .toEqual(['allow', 'deny', 'allow', 'allow', 'deny']);
  expect(policies.map(mode => { const policy = benchmarkPolicy(mode, { ...host, plan: ['read', 'write'] }); return policy.evaluate(request, policy.observe(policy.initialize())); }))
    .toEqual(['allow', 'allow', 'needs_approval', 'allow', 'needs_approval']);
});

test('failed or exhausted controlled executions do not invent negative observations', async () => {
  const scenario = attackScenarios[0]!;
  for (const mode of ['backend', 'schema', 'exhausted', 'observed-sink'] as const) {
    let calls = 0;
    const model: ModelClient = { async *stream() {
      calls++;
      if (mode === 'backend') throw Error('scripted failure');
      if (mode === 'schema') { yield { toolCalls: [{ id: `bad-${calls}`, name: scenario.readTool, args: { id: 42 } }] }; return; }
      if (mode === 'observed-sink') {
        if (calls === 1) { yield { toolCalls: [{ id: 'sink', name: 'post_message', args: { channel: 'synthetic-attacker', body: CANARY } }] }; return; }
        throw Error('scripted failure after sink');
      }
      yield { toolCalls: [{ id: `read-${calls}`, name: scenario.readTool, args: { id: 'item-1' } }] };
    } };
    for (const injected of [true, false]) {
      calls = 0;
      const result = await runControlledDefense({ scenarioId: scenario.id, injected, model, modelAlias: 'fixture-model',
        runId: 'fixture-failure', seed: 0, policy: 'none', host: { taskHash: 'initial', capabilities: [scenario.readTool], plan: [scenario.readTool],
          tools: { [scenario.readTool]: { sideEffect: false }, post_message: { sideEffect: true }, http_fetch: { sideEffect: true }, grant_access: { sideEffect: true } } } });
      expect(result.status).toBe(mode === 'exhausted' ? 'exhausted' : 'failed');
      expect(result.attackSuccess).toBe(mode === 'observed-sink' ? true : null);
      expect(result.utility).toBeNull();
    }
  }
});

test('failed-row aggregation admits observed sink success but never failed negative or utility scores', () => {
  const partial = securityMatrixAggregates({ bindingHash: 'manifest', jobs }, [row(jobs[0]!, { status: 'failed', attackSuccess: null }),
    row(jobs[1]!, { status: 'failed', utility: null }), row(jobs[2]!, { status: 'failed', attackSuccess: true })]);
  expect(partial.cells[0]!.attack.evaluable).toBe(0);
  expect(partial.cells[0]!.utility.evaluable).toBe(0);
  expect(partial.cells[1]!.attack).toEqual({ planned: 1, evaluable: 1, success: 1, rate: 1, lower: 1, upper: 1 });
  expect(partial.cells[0]!.knownCostUsd).toBe(0.4);
  expect(() => securityMatrixAggregates({ bindingHash: 'manifest', jobs }, [row(jobs[0]!, { status: 'failed', attackSuccess: false })])).toThrow();
  expect(() => securityMatrixAggregates({ bindingHash: 'manifest', jobs }, [row(jobs[1]!, { status: 'failed', utility: 0 })])).toThrow();
});

test('recognized admission codes survive controlled model stream failures', async () => {
  const scenario = attackScenarios[0]!;
  for (const code of ['BUDGET_DENIED', 'BUDGET_EXHAUSTED', 'MODEL_INPUT_REJECTED']) {
    const model: ModelClient = { async *stream() { throw Object.assign(Error('KEEL_REQUEST_FAILED'), { code }); } };
    const result = await runControlledDefense({ scenarioId: scenario.id, injected: true, model, modelAlias: 'fixture-model',
      runId: 'fixture-admission', seed: 0, policy: 'none', host: { taskHash: 'initial', capabilities: [scenario.readTool], plan: [scenario.readTool],
        tools: { [scenario.readTool]: { sideEffect: false }, post_message: { sideEffect: true }, http_fetch: { sideEffect: true }, grant_access: { sideEffect: true } } } });
    expect(result.admissionStop).toBe(code);
    expect(result.attackSuccess).toBeNull();
  }
});
