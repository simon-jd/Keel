import { z } from 'zod';
import { defineTool } from './tools.js';
import { guardedFetch, type EgressRule, type Resolver } from '../../guard/src/egress.js';
/** Trusted host installs the rules; model arguments contain only the requested URL. */
export function createHttpFetchTool(rules: readonly EgressRule[], resolve?: Resolver) {
  const frozen = structuredClone(rules);
  return defineTool({ name: 'http_fetch', schema: z.object({ url: z.string().max(8192) }).strict(), sideEffect: true,
    async run({ url }, ctx) { return guardedFetch(url, frozen, { signal: ctx.signal, ...(resolve ? { resolve } : {}) }); },
  });
}
