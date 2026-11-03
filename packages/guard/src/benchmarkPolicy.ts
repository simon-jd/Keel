/** Explicit isolated virtual-benchmark composition. Production hosts use createGuard.
 * Tool registry, capability list and plan are installed by the trusted host before
 * any model or tool observation. This module never executes an external tool. */
import { hash } from '../../runtime/src/actions.js';
import type { SecurityPolicy, SecurityState } from '../../runtime/src/types.js';
import { createGuard } from './policy.js';
export const policies = ['none', 'capability', 'taint', 'plan', 'all'] as const;
/** Phase 6 refinements of taint and all (see provenance.ts). `provenance`: no capability/plan limit, value-level
 * provenance instead of session taint. `all-prov`: capability and plan restrict side-effecting tools only (read-only
 * tools are always allowed), plus value-level provenance. The provenance check itself runs in the host bridge. */
export const extendedPolicies = [...policies, 'provenance', 'all-prov'] as const;
export type Defense = typeof extendedPolicies[number];
export const provenanceModes: readonly Defense[] = ['provenance', 'all-prov'];
/** all-prov widens the trusted declaration with every read-only tool. */
export function widenReadOnly(list: readonly string[], tools: Record<string, { sideEffect: boolean }>): string[] {
  return [...new Set([...list, ...Object.keys(tools).filter(t => !tools[t]!.sideEffect)])];
}
export type BenchmarkHost = { taskHash: string; capabilities: string[]; plan: string[]; tools: Record<string, { sideEffect: boolean }> };
export function benchmarkPolicy(mode: Defense, host: BenchmarkHost): SecurityPolicy {
  host = structuredClone(host);
  if (!extendedPolicies.includes(mode) || !host.taskHash || !Array.isArray(host.capabilities) || !Array.isArray(host.plan)
    || !host.tools || !Object.keys(host.tools).length || Object.values(host.tools).some(t => typeof t.sideEffect !== 'boolean')
    || [...host.capabilities, ...host.plan].some(t => !Object.hasOwn(host.tools, t))
    || new Set(host.capabilities).size !== host.capabilities.length) throw Error('INVALID_BENCHMARK_HOST');
  const capabilities = mode === 'capability' || mode === 'all' ? [...host.capabilities] : mode === 'all-prov' ? widenReadOnly(host.capabilities, host.tools) : Object.keys(host.tools);
  const taint = mode === 'taint' || mode === 'all';
  const inner = createGuard({ ...(mode === 'plan' || mode === 'all' ? { plan: host.plan } : mode === 'all-prov' ? { plan: widenReadOnly(host.plan, host.tools) } : {}),
    allowUntainted: Object.keys(host.tools),
    // This is an in-process virtual sink only. No network transport is installed.
    egress: [{ scheme: 'https:', host: 'sink.invalid', path: '/collect' }] });
  const policyHash = hash({ version: 'keel-virtual-benchmark-v1', mode, host, inner: inner.policyHash });
  const unwrap = (state: SecurityState) => ({ ...state, policyHash: inner.policyHash });
  return {
    policyHash,
    initialize: () => ({ ...inner.initialize(), policyHash }),
    validate: state => state?.policyHash === policyHash && inner.validate(unwrap(state)),
    observe: state => ({ ...state, observed: taint || state.observed }),
    evaluate(request, state) {
      if (!this.validate(state) || !Object.hasOwn(host.tools, request.tool)) return 'deny';
      return inner.evaluate({ ...request, capabilities, sideEffect: host.tools[request.tool]!.sideEffect }, unwrap(state));
    },
  };
}
