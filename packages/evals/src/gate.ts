/** taskHash binds source data, not the rendered prompt. Execution changes are recorded,
 * while population/envelope and case+seed identities must remain comparable. */
export type Report = {
  execution: { implementation: string; prompt: string; policy: string; models: string[] };
  population: { dataset: string; protocol: string; scorer: string; settings: string; seed: number };
  runs: { id: string; runId: string; taskHash: string; status: 'completed' | 'failed' | 'incomplete'; success: boolean; costUsd: number; costStatus: 'known' | 'unknown' }[];
};
const populationFields = ['dataset','protocol','scorer','settings'] as const;
const executionFields = ['implementation','prompt','policy'] as const;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function valid(r: Report): boolean {
  return !!r && !!r.execution && executionFields.every(k=>text(r.execution[k])) &&
    Array.isArray(r.execution.models) && r.execution.models.length > 0 && r.execution.models.every(text) &&
    !!r.population && populationFields.every(k=>text(r.population[k])) &&
    Number.isSafeInteger(r.population.seed) && r.population.seed >= 0 && r.population.seed <= 2147483647 && Array.isArray(r.runs) && r.runs.length > 0 &&
    new Set(r.runs.map(x=>x?.id)).size === r.runs.length && new Set(r.runs.map(x=>x?.runId)).size === r.runs.length &&
    r.runs.every(x=>!!x && text(x.id) && text(x.runId) && text(x.taskHash) && ['completed','failed','incomplete'].includes(x.status) &&
      typeof x.success === 'boolean' && (!x.success || x.status === 'completed') &&
      ['known','unknown'].includes(x.costStatus) && Number.isFinite(x.costUsd) && x.costUsd >= 0);
}
// Decimal arithmetic on the supplied finite numbers avoids floating point threshold
// drift (e.g. 0.1 * 1.1), without hiding a genuinely just-above-boundary value.
function decimal(value: number): { units: bigint; exponent: number } {
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  return { units: BigInt(whole! + fraction), exponent: Number(exponent) - fraction.length };
}
export function gate(baseline: Report, candidate: Report): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!valid(baseline) || !valid(candidate)) return { pass: false, reasons: ['INVALID_REPORT'] };
  if (baseline.population.seed !== candidate.population.seed || populationFields.some(k=>baseline.population[k] !== candidate.population[k])) reasons.push('INCOMPARABLE_POPULATION');
  const other = new Map(candidate.runs.map(x=>[x.id,x]));
  if (baseline.runs.length !== candidate.runs.length || baseline.runs.some(x=>other.get(x.id)?.taskHash !== x.taskHash)) reasons.push('UNPAIRED_CASES');
  if ([...baseline.runs,...candidate.runs].some(x=>x.status === 'incomplete')) reasons.push('INCOMPLETE_POPULATION');
  if ([...baseline.runs,...candidate.runs].some(x=>x.costStatus !== 'known')) reasons.push('UNKNOWN_COST');
  if (reasons.length) return { pass: false, reasons };
  const count = baseline.runs.length;
  if ((baseline.runs.filter(x=>x.success).length - candidate.runs.filter(x=>x.success).length) * 50 > count) reasons.push('SUCCESS_DROP_EXCEEDS_2PP');
  const b = baseline.runs.map(x=>decimal(x.costUsd)), c = candidate.runs.map(x=>decimal(x.costUsd));
  const exponent = Math.min(...b.map(x=>x.exponent),...c.map(x=>x.exponent));
  const sum = (values: typeof b) => values.reduce((s,x)=>s + x.units * 10n ** BigInt(x.exponent - exponent),0n);
  if (sum(c) * 10n > sum(b) * 11n) reasons.push('COST_INCREASE_EXCEEDS_10_PERCENT');
  return { pass: reasons.length === 0, reasons };
}
