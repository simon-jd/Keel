import { withSpan } from 'tracing/span';
import { runCost } from './cost.js';
import { z } from 'zod';
import type { ChatChunk, ToolCall } from 'models/types';
import { actionKey, canonical, hash } from './actions.js';
import { available, limits } from './budget.js';
import { authorizeCall, requiresApproval } from './tools.js';
import type { RunSession } from './store.js';
import type { Approval, Checkpoint, Deps, ErrorCode, RunResult, Task } from './types.js';

const taskSchema = z.object({ tenantId: z.string().min(1).max(256), input: z.string().min(1).max(1_000_000), model: z.string().min(1).max(256), capabilities: z.array(z.string().min(1)).max(256) }).strict();
const callSchema = z.object({ id: z.string().min(1), name: z.string().min(1), args: z.unknown() });
const chunkSchema = z.object({ text: z.string().optional(), toolCalls: z.array(callSchema).optional(), invalidToolCalls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), error: z.enum(['malformed_json', 'unknown_tool']) })).optional() }).passthrough();
const nonnegative = z.number().finite().nonnegative();
const usageSchema = z.object({ input: nonnegative.int(), output: nonnegative.int() });
const accountingSchema = z.object({
  run_id: z.string().optional(), call_id: z.string().optional(), model: z.string(), provider: z.enum(['openai', 'anthropic', 'openaiCompatible']),
  status: z.enum(['success', 'failed', 'aborted']), usage: usageSchema.optional(), costUsd: nonnegative, costStatus: z.enum(['known', 'unknown']),
  attempts: z.array(z.object({ attempt: nonnegative.int(), outcome: z.enum(['success', 'failed', 'aborted']), costStatus: z.enum(['known', 'unknown']), usage: usageSchema.optional(), costUsd: nonnegative.optional() })),
});
function delivery(raw: unknown): Pick<ChatChunk, 'accounting' | 'observerStatus'> {
  if (typeof raw !== 'object' || raw === null) return {};
  const value = raw as Record<string, unknown>;
  const parsed = accountingSchema.safeParse(value.accounting);
  return { ...(parsed.success ? { accounting: parsed.data as NonNullable<ChatChunk['accounting']> } : {}),
    ...(value.observerStatus === 'failed' || value.observerStatus === 'delivered' ? { observerStatus: value.observerStatus } : {}) };
}
const failure = (errorCode: ErrorCode): RunResult => ({ status: 'FAILED', errorCode, budget: { modelCalls: 0, toolCalls: 0 } });

export async function runAgent(runId: string, task: Task, deps: Deps): Promise<RunResult> {
  let fingerprint: string; let cap;
  try {
    runId = z.uuid().parse(runId).toLowerCase(); task = taskSchema.parse(task); cap = limits(deps.budget);
    if (new Set(deps.tools.map(t => t.name)).size !== deps.tools.length) return failure('INVALID_INPUT');
    fingerprint = hash({ task, limits: cap, policyVersion: deps.policyVersion ?? 'baseline-v1', ...(deps.security ? { securityPolicy: deps.security.policyHash } : {}), tools: deps.tools.map(t => ({ definition: t.definition, sideEffect: t.sideEffect })).sort((a, b) => a.definition.name.localeCompare(b.definition.name)) });
  } catch { return failure('INVALID_INPUT'); }
  try {
    return await deps.store.withRun(runId, async session => {
      const row = await session.load();
      let checkpoint: Checkpoint;
      if (row) {
        checkpoint = row.budgetJson as Checkpoint;
        if (row.tenantId !== task.tenantId || checkpoint.version !== 1 || checkpoint.fingerprint !== fingerprint) return failure('RUN_INPUT_MISMATCH');
        if (deps.security && (!checkpoint.security || !deps.security.validate(checkpoint.security))) return failure('RUN_INPUT_MISMATCH');
        if (checkpoint.result && checkpoint.result.status !== 'NEEDS_APPROVAL') return { ...checkpoint.result, cost: runCost(checkpoint) };
        delete checkpoint.result;
      } else {
        checkpoint = { ...(deps.security ? { security: deps.security.initialize() } : {}), version: 1, fingerprint, limits: cap, used: { modelCalls: 0, toolCalls: 0 }, messages: [{ role: 'user', content: task.input }], nextSeq: 0, corrections: 0, pending: [], deliveries: [] };
        await session.create(task.tenantId, checkpoint);
      }
      return loop(runId, task, deps, session, checkpoint);
    }) ?? failure('RUN_BUSY');
  } catch { return failure('STORE_ERROR'); }
}

async function loop(runId: string, task: Task, deps: Deps, session: RunSession, state: Checkpoint): Promise<RunResult> {
  const signal = deps.signal ? AbortSignal.any([deps.signal, session.signal]) : session.signal;
  const finish = async (status: RunResult['status'], errorCode?: ErrorCode, extra: Pick<RunResult, 'output' | 'approval'> = {}, step?: Parameters<RunSession['save']>[2]): Promise<RunResult> => {
    const result: RunResult = { status, budget: { ...state.used }, cost: runCost(state), ...extra, ...(errorCode ? { errorCode } : {}) };
    state.result = result;
    await session.save(state, status, step);
    return result;
  };
  while (true) {
    if (signal.aborted) return finish('FAILED', 'CANCELLED');
    while (state.pending.length) {
      const pending = state.pending[0]!;
      const tool = deps.tools.find(t => t.name === pending.name)!;
      const key = actionKey(runId, pending.seq, tool.name, pending.args);
      const binding: Approval = { tenantId: task.tenantId, runId, tool: tool.name, actionKey: key, argsHash: hash(pending.args) };
      let action = await session.action(key);
      if (action?.status === 'PENDING') {
        await session.markAction(key, 'UNKNOWN');
        action = { ...action, status: 'UNKNOWN' };
      }
      let authorization;
      try { authorization = await authorizeCall(tool, binding, task, deps, pending.args, state.security); }
      catch { return finish('FAILED', 'TOOL_DENIED'); }
      if (authorization.decision === 'deny') return finish('FAILED', 'TOOL_DENIED');
      if (authorization.decision === 'needs_approval') return finish('NEEDS_APPROVAL', 'APPROVAL_REQUIRED', { approval: binding });
      if (signal.aborted) return finish('FAILED', 'CANCELLED');
      if (action?.status === 'UNKNOWN') {
        let lookup: 'done' | 'absent' | undefined;
        try { lookup = await tool.lookup?.(key); } catch { /* Ambiguous external state stays UNKNOWN. */ }
        if (lookup === 'done') {
          await session.markAction(key, 'SUCCEEDED', { reconciled: true });
          action = { ...action, status: 'SUCCEEDED', resultJson: { reconciled: true } };
        } else if (lookup !== 'absent') return finish('NEEDS_APPROVAL', 'ACTION_UNKNOWN', { approval: binding });
        else action = undefined;
      }
      if (action?.status === 'FAILED') return finish('FAILED', 'TOOL_ERROR');
      let result: unknown = action?.resultJson;
      if (!action) {
        if (!available(state.used, state.limits, 'toolCalls')) return finish('BUDGET_EXCEEDED', 'BUDGET_EXCEEDED');
        state.used.toolCalls++;
        await session.reserveAction(state, key, tool.name, binding.argsHash, { seq: pending.seq, kind: 'tool', payload: { id: pending.id, name: pending.name, args: pending.args }, status: 'PENDING' });
        try {
          signal.throwIfAborted();
          result = await withSpan(tool.traceKind ?? 'tool', { 'keel.run_id': runId }, async () => {
            // Undefined is a normal void tool return; any other non-JSON result is ambiguous.
            const value = await tool.run(structuredClone(pending.args), { ...binding, signal, ...(authorization.policyAuthorization ? { policyAuthorization: authorization.policyAuthorization } : {}) }) ?? null;
            canonical(value);
            return value;
          });
        } catch {
          const ambiguous = requiresApproval(tool);
          await session.markAction(key, ambiguous ? 'UNKNOWN' : 'FAILED');
          return finish(ambiguous ? 'NEEDS_APPROVAL' : 'FAILED', ambiguous ? 'ACTION_UNKNOWN' : 'TOOL_ERROR', ambiguous ? { approval: binding } : {});
        }
        await session.markAction(key, 'SUCCEEDED', result);
      }
      if (deps.security && state.security) state.security = deps.security.observe(state.security);
      state.messages.push({ role: 'tool', content: canonical(result), toolCallId: pending.id });
      state.pending.shift();
      await session.save(state, 'RUNNING', { seq: pending.seq, kind: 'tool', payload: { id: pending.id, name: pending.name, args: pending.args, result }, status: 'SUCCEEDED' });
      if (signal.aborted) return finish('FAILED', 'CANCELLED');
    }
    if (!available(state.used, state.limits, 'modelCalls')) return finish('BUDGET_EXCEEDED', 'BUDGET_EXCEEDED');
    const seq = state.nextSeq++;
    const callId = `${runId}:${seq}`;
    state.used.modelCalls++;
    await session.save(state, 'RUNNING', { seq, kind: 'model', payload: { callId }, status: 'PENDING' });
    let response: ChatChunk = { text: '', toolCalls: [], invalidToolCalls: [] };
    let hasContent = false;
    try {
      for await (const raw of deps.model.stream({ model: task.model, messages: structuredClone(state.messages), tools: deps.tools.map(t => t.definition) }, { signal, run_id: runId, call_id: callId })) {
        const chunk = chunkSchema.parse(raw);
        if (chunk.text !== undefined || chunk.toolCalls?.length || chunk.invalidToolCalls?.length) hasContent = true;
        response.text += chunk.text ?? '';
        response.toolCalls!.push(...(chunk.toolCalls as ToolCall[] ?? []));
        response.invalidToolCalls!.push(...(chunk.invalidToolCalls ?? []));
        Object.assign(response, delivery(raw));
      }
    } catch (error) {
      state.deliveries.push({ callId, ...delivery(error) });
      return finish('FAILED', signal.aborted ? 'CANCELLED' : error instanceof z.ZodError ? 'INVALID_MODEL_RESPONSE' : 'MODEL_ERROR');
    }
    state.deliveries.push({ callId, ...(response.accounting ? { accounting: response.accounting } : {}), ...(response.observerStatus ? { observerStatus: response.observerStatus } : {}) });
    if (signal.aborted) return finish('FAILED', 'CANCELLED');
    if (!hasContent) return finish('FAILED', 'INVALID_MODEL_RESPONSE');
    const calls = response.toolCalls!;
    const invalid = response.invalidToolCalls!;
    if (new Set([...calls, ...invalid].map(c => c.id)).size !== calls.length + invalid.length) return finish('FAILED', 'INVALID_MODEL_RESPONSE');
    const parsed: ToolCall[] = [];
    let invalidCode: ErrorCode | undefined = invalid.some(c => c.error === 'unknown_tool') ? 'UNKNOWN_TOOL' : invalid.length ? 'INVALID_TOOL_ARGS' : undefined;
    for (const call of calls) {
      const tool = deps.tools.find(t => t.name === call.name);
      if (!tool) { invalidCode = 'UNKNOWN_TOOL'; continue; }
      try {
        const args: unknown = tool.schema.parse(call.args);
        canonical(args); parsed.push({ ...call, args });
      } catch { invalidCode ??= 'INVALID_TOOL_ARGS'; }
    }
    if (invalidCode) {
      // No member of an invalid batch executes. Object placeholders preserve Anthropic tool_use input shape.
      state.messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: [...calls.map(c => ({ ...c, args: {} })), ...invalid.map(c => ({ id: c.id, name: c.name, args: {} }))] });
      for (const call of [...calls, ...invalid]) state.messages.push({ role: 'tool', content: JSON.stringify({ error: invalidCode }), toolCallId: call.id });
      state.corrections++;
      const failedStep = { seq, kind: 'model', payload: { callId, errorCode: invalidCode }, status: 'FAILED' };
      if (state.corrections > 2) return finish('FAILED', invalidCode, {}, failedStep);
      await session.save(state, 'RUNNING', failedStep);
      continue;
    }
    state.corrections = 0;
    state.messages.push({ role: 'assistant', content: response.text ?? '', ...(parsed.length ? { toolCalls: parsed } : {}) });
    state.pending = parsed.map(c => ({ ...c, seq: state.nextSeq++ }));
    const completedStep = { seq, kind: 'model', payload: { callId, response }, status: 'SUCCEEDED' };
    if (!parsed.length) return finish('DONE', undefined, { output: response.text ?? '' }, completedStep);
    await session.save(state, 'RUNNING', completedStep);
  }
}
