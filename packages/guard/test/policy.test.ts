import { expect, test } from 'vitest';
import { concat, fromTool, trusted, template, jsonStringify, jsonParse } from '../src/taint.js';
import { check, createGuard } from '../src/policy.js';
import { approvalMatches } from '../src/approval.js';
import { hash, actionKey } from '../../runtime/src/actions.js';
const args = { text: 'synthetic' };
const binding = { tenantId: 'tenant-a', runId: '10000000-0000-4000-8000-000000000001', tool: 'post_message', argsHash: hash(args), actionKey: actionKey('run', 0, 'post_message', args) };
const request = { ...binding, args, sideEffect: true, capabilities: ['post_message'] };
test('taintPropagatesThroughTemplatesAndJSON', () => {
  const input = fromTool('synthetic injection', { kind: 'retrieval', id: 'item' });
  const text = template`before ${concat(trusted('prefix'), input)} after`;
  expect(text.tainted).toBe(true);
  const wire = jsonStringify({ nested: [text] });
  expect(wire.tainted).toBe(true);
  expect(jsonParse(wire).tainted).toBe(true);
  // JSON's tainted:false is data; a host tool result remains untrusted.
  expect(fromTool('{"tainted":false,"text":"clean"}', { kind: 'tool', id: 'x' }).tainted).toBe(true);
});
test('taintedArgToSensitiveToolNeedsApproval', () => {
  expect(check({ name: 'post_message', args: fromTool('rewrite', { kind: 'tool', id: 'r' }) }, { capabilities: ['post_message'] })).toBe('needsApproval');
});
test('untaintedArgAllowed', () => {
  expect(check({ name: 'post_message', args: trusted('draft') }, { capabilities: ['post_message'], allowUntainted: [] })).toBe('needsApproval');
  expect(check({ name: 'post_message', args: trusted('draft') }, { capabilities: ['post_message'], allowUntainted: ['post_message'] })).toBe('allow');
});
test('capabilityOutsideTaskDenied', () => {
  expect(check({ name: 'post_message', args: trusted('draft') }, { capabilities: [], allowUntainted: ['post_message'] })).toBe('deny');
});
test('planModeBlocksNewTools', () => {
  const guard = createGuard({ plan: ['search'], allowUntainted: ['post_message'] });
  const state = guard.initialize();
  expect(guard.evaluate(request, state)).toBe('deny');
  expect(state.plan).toEqual(['search']);
});
test('approvalBindsToExactArgsHash', () => {
  expect(approvalMatches(binding, [binding])).toBe(true);
  for (const altered of [{ ...binding, argsHash: hash({ text: 'changed' }) }, { ...binding, tenantId: 'tenant-b' }, { ...binding, runId: '20000000-0000-4000-8000-000000000002' }, { ...binding, tool: 'create_issue' }, { ...binding, actionKey: 'b'.repeat(64) }]) expect(approvalMatches(altered, [binding])).toBe(false);
});
