import { z } from 'zod';
import type { Budget } from './types.js';
const cap = z.number().int().nonnegative().max(1_000_000);
export const budgetSchema = z.object({ modelCalls: cap.default(8), toolCalls: cap.default(16) });
export function limits(input: Partial<Budget> = {}): Budget { return budgetSchema.parse(input); }
export function available(used: Budget, limit: Budget, kind: keyof Budget): boolean { return used[kind] < limit[kind]; }
