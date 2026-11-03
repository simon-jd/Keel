import { hash, canonical } from '../../runtime/src/actions.js';
import type { GuardRequest, SecurityPolicy, SecurityState } from '../../runtime/src/types.js';
import { provenance } from './taint.js';
import { freezePlan, planned } from './planExecute.js';
import { checkUrl, type EgressRule } from './egress.js';
export type ToolCall = { name: string; args: unknown; sideEffect?: boolean };
export type TaskContext = { capabilities: readonly string[]; allowUntainted?: readonly string[]; tainted?: boolean; plan?: readonly string[] | null; egress?: readonly EgressRule[] };
export type GuardOptions = { plan?: readonly string[]; allowUntainted?: readonly string[]; egress?: readonly EgressRule[] };
const sensitive = new Set(['post_message', 'create_issue', 'update_case_status', 'http_fetch', 'draft_reply']);
function isSensitive(call: ToolCall): boolean { return call.sideEffect === true || sensitive.has(call.name.split('.').at(-1)!); }
export function check(call: ToolCall, ctx: TaskContext): 'allow' | 'deny' | 'needsApproval' {
  if (!ctx.capabilities.includes(call.name)) return 'deny';
  if (ctx.plan && !ctx.plan.includes(call.name)) return 'deny';
  if (call.name.split('.').at(-1) === 'http_fetch') {
    try { checkUrl((call.args as { url?: unknown })?.url, ctx.egress ?? []); } catch { return 'deny'; }
  }
  if (isSensitive(call)) {
    if (ctx.tainted || provenance(call.args).tainted || !ctx.allowUntainted?.includes(call.name)) return 'needsApproval';
  }
  return 'allow';
}
/** Monotonic, conservative information-flow policy: after any tool observation every later
 * sensitive argument is tainted, including paraphrases, encodings and model-produced JSON. */
export function createGuard(options: GuardOptions = {}): SecurityPolicy {
  const config = structuredClone({ plan: freezePlan(options.plan), allowUntainted: [...(options.allowUntainted ?? [])].sort(), egress: [...(options.egress ?? [])] });
  const policyHash = hash({ version: 'keel-guard-v1', ...config });
  const initialize = (): SecurityState => ({ version: 1, policyHash, observed: false, plan: config.plan === null ? null : [...config.plan] });
  return {
    policyHash, initialize,
    validate(state) {
      return state?.version === 1 && state.policyHash === policyHash && typeof state.observed === 'boolean' && canonical(state.plan) === canonical(config.plan);
    },
    observe(state) { return { ...state, observed: true }; },
    evaluate(request: GuardRequest, state: SecurityState) {
      if (!this.validate(state) || !planned(request.tool, state)) return 'deny';
      const decision = check({ name: request.tool, args: request.args, sideEffect: request.sideEffect }, { capabilities: request.capabilities, allowUntainted: config.allowUntainted, tainted: state.observed, plan: state.plan, egress: config.egress });
      return decision === 'needsApproval' ? 'needs_approval' : decision;
    },
  };
}

/** CPU controlled harness adapter. The caller supplies only trusted initial policy;
 * observed tool output monotonically taints every later sensitive model argument. */
export function createControlledGuard(options: GuardOptions = {}) {
  const policy = createGuard(options); let state = policy.initialize(); let seq = 0;
  return {
    dispatch(request: { tool: string; args: unknown; requestedCapabilities: readonly string[] }) {
      const binding = { tenantId: 'controlled-fixture', runId: '10000000-0000-4000-8000-000000000001', tool: request.tool, argsHash: hash(request.args), actionKey: hash([seq++, request.tool, request.args]) };
      const sideEffect = !/^(read_|get_)/.test(request.tool);
      const decision = policy.evaluate({ ...binding, args: request.args, capabilities: request.requestedCapabilities, sideEffect }, state);
      if (decision !== 'allow') throw Error('HOST_DENIED');
    },
    observe() { state = policy.observe(state); },
  };
}
