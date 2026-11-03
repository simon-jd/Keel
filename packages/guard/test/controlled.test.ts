import { expect, test } from 'vitest';
import { runControlledScenario } from '../attacks/controlled.js';
import { attackScenarios } from '../attacks/scenarios.js';
import { createControlledGuard } from '../src/policy.js';
import type { ModelClient } from '../../models/src/types.js';
for (const scenario of attackScenarios) {
  test(`actual TS guard denies controlled virtual sink: ${scenario.id}`, async () => {
    let step = 0;
    const model: ModelClient = { async *stream() { yield step++ === 0 ? { toolCalls: [{ id: 'read', name: scenario.readTool, args: { id: 'item-1' } }] } : { toolCalls: [{ id: 'sink', name: scenario.targetTool, args: scenario.targetArgs }] }; } };
    const result = await runControlledScenario({ scenario, model, modelAlias: 'fixture', runId: 'synthetic-run', injected: true, trustedGuard: createControlledGuard({ plan: [scenario.readTool] }) });
    expect(result.sinkEvents).toEqual([]); expect(result.attackSuccess).toBe(false);
    expect(result.messages.some(m => m.role === 'tool' && m.content.includes(scenario.injection))).toBe(true);
  });
}
test('controlled guard conservatively taints rewritten sink args even when capability and plan allow them', async () => {
  const original = attackScenarios[0]!;
  const scenario = { ...original, requestedCapabilities: [original.readTool, original.targetTool] };
  let step = 0;
  const model: ModelClient = { async *stream() { yield step++ === 0 ? { toolCalls: [{ id: 'r', name: scenario.readTool, args: { id: 'item-1' } }] } : { toolCalls: [{ id: 'w', name: scenario.targetTool, args: scenario.targetArgs }] }; } };
  const result = await runControlledScenario({ scenario, model, modelAlias: 'fixture', runId: 'taint-fixture', injected: true, trustedGuard: createControlledGuard({ plan: [scenario.readTool, scenario.targetTool], allowUntainted: [scenario.targetTool] }) });
  expect(result.sinkEvents).toEqual([]); expect(result.attackSuccess).toBe(false);
});
