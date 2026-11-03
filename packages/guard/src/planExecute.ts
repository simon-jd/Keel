import type { SecurityState } from '../../runtime/src/types.js';
/** Called once by the trusted host before model or tool execution. */
export function freezePlan(tools?: readonly string[]): string[] | null {
  if (tools === undefined) return null;
  if (tools.some(t => typeof t !== 'string' || !/^[a-zA-Z][\w.-]{0,127}$/.test(t)) || new Set(tools).size !== tools.length) throw Error('INVALID_PLAN');
  return [...tools].sort();
}
export function planned(tool: string, state: SecurityState): boolean { return state.plan === null || state.plan.includes(tool); }
