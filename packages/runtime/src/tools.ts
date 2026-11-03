import { z } from 'zod';
import type { ToolDef } from 'models/types';
import type { Approval, Deps, Task, SecurityState } from './types.js';
export type PolicyAuthorization = { readonly source: 'policy'; readonly policyHash: string };
const permits = new WeakMap<PolicyAuthorization, { binding: Approval; capabilities: readonly string[] }>();
/** Only in-process trusted host permits are accepted, never deserialized model fields. */
export function policyBinding(permit: PolicyAuthorization): Approval | undefined { return permits.get(permit)?.binding; }
export function policyCapabilities(permit: PolicyAuthorization): readonly string[] | undefined { return permits.get(permit)?.capabilities; }
export type ToolContext = Approval & { signal: AbortSignal; policyAuthorization?: PolicyAuthorization };
export type Tool = {
  name: string; schema: z.ZodType; sideEffect: boolean; traceKind?: 'tool' | 'retrieval'; definition: ToolDef;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
  lookup?: (actionKey: string) => Promise<'done' | 'absent'>;
};
export function defineTool<A>(t: { name: string; schema: z.ZodType<A>; sideEffect: boolean; traceKind?: 'tool' | 'retrieval'; run(args: A, ctx: ToolContext): Promise<unknown>; lookup?(actionKey: string): Promise<'done' | 'absent'> }): Tool {
  if (!/^[a-zA-Z][\w.-]{0,127}$/.test(t.name) || typeof t.sideEffect !== 'boolean' || typeof t.run !== 'function') throw new Error('INVALID_TOOL');
  return {
    name: t.name, schema: t.schema, sideEffect: t.sideEffect, ...(t.traceKind ? { traceKind: t.traceKind } : {}),
    definition: { name: t.name, parameters: z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' }) },
    run: (args, ctx) => t.run(args as A, ctx), ...(t.lookup ? { lookup: t.lookup } : {}),
  };
}
/** Fail closed for unknown verbs; default external writes require exact human approval. */
export function requiresApproval(tool: Tool): boolean {
  const words = tool.name.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase().split(/[._-]/);
  const sensitive = /^(send|write|create|delete|remove|update|post|put|patch|execute|exec|run|shell|upload|transfer|pay|invite|grant|revoke|set|mutate|publish)$/;
  return tool.sideEffect || words.some(w => sensitive.test(w)) || !words.some(w => /^(get|read|list|search|lookup|fetch|find|describe)$/.test(w));
}
export async function authorizeCall(tool: Tool, binding: Approval, task: Task, deps: Deps, args: unknown, state?: SecurityState): Promise<{ decision: 'allow' | 'deny' | 'needs_approval'; policyAuthorization?: PolicyAuthorization }> {
  const request = { ...binding, args: structuredClone(args), capabilities: [...task.capabilities], sideEffect: requiresApproval(tool) };
  const decision = deps.guard ? await deps.guard(structuredClone(request)) : 'allow';
  const host = deps.security && state ? deps.security.evaluate(structuredClone(request), structuredClone(state)) : undefined;
  if (!['allow', 'deny', 'needs_approval'].includes(decision) || host !== undefined && !['allow', 'deny', 'needs_approval'].includes(host) || decision === 'deny' || host === 'deny' || deps.security && !state) return { decision: 'deny' };
  const approved = deps.approvals?.some(a => a.tenantId === binding.tenantId && a.runId === binding.runId && a.tool === binding.tool && a.actionKey === binding.actionKey && a.argsHash === binding.argsHash);
  if ((requiresApproval(tool) || decision === 'needs_approval' || host === 'needs_approval') && !approved) {
    if (host !== 'allow' || decision === 'needs_approval') return { decision: 'needs_approval' };
    const policyAuthorization = Object.freeze({ source: 'policy' as const, policyHash: deps.security!.policyHash });
    permits.set(policyAuthorization, { binding: Object.freeze({ ...binding }), capabilities: Object.freeze([...task.capabilities]) });
    return { decision: 'allow', policyAuthorization };
  }
  return { decision: 'allow' };
}
export async function authorize(tool: Tool, binding: Approval, task: Task, deps: Deps, args: unknown): Promise<'allow' | 'deny' | 'needs_approval'> {
  return (await authorizeCall(tool, binding, task, deps, args)).decision;
}
