import type { Approval } from '../../runtime/src/types.js';
/** All five fields are mandatory. Hashes are minted with runtime/actions.hash. */
export function approvalMatches(binding: Approval, approvals: readonly Approval[]): boolean {
  return approvals.some(a => a.tenantId === binding.tenantId && a.runId === binding.runId && a.tool === binding.tool && a.actionKey === binding.actionKey && a.argsHash === binding.argsHash);
}
