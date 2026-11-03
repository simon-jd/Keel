import type { Checkpoint, RunCost } from './types.js';
/** Checkpoint accounting is the source of truth, independent of exporter delivery and process lifetime. */
export function runCost(state: Checkpoint): RunCost {
  const calls = new Map(state.deliveries.map(d => [d.callId, d.accounting]));
  let knownUsd = 0;
  let unknown = calls.size !== state.used.modelCalls;
  for (const accounting of calls.values()) {
    if (!accounting) { unknown = true; continue; }
    knownUsd += accounting.costUsd;
    if (accounting.costStatus === 'unknown') unknown = true;
  }
  return { status: unknown ? 'unknown' : 'known', knownUsd, totalUsd: unknown ? null : knownUsd };
}
