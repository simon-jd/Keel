import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { hash, canonical } from 'runtime/actions';
import { policyBinding, policyCapabilities, type PolicyAuthorization } from 'runtime/tools';
import type { Approval, GuardRequest } from 'runtime/types';
export const bindingSchema = z.object({ tenantId: z.string().min(1).max(256), runId: z.uuid(), tool: z.string().min(1).max(128), actionKey: z.string().regex(/^[a-f0-9]{64}$/), argsHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const authorizationSchema = z.union([
  z.object({ source: z.literal('human') }).strict(),
  z.object({ source: z.literal('policy'), policyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type Guard = (request: GuardRequest) => Promise<'allow' | 'deny' | 'needs_approval'>;
/** Host-only capability issuer. Never expose issue(), key, approvals or guard to a model/HTTP route. */
export class ApprovalAuthority {
  #key: Buffer;
  constructor(key: Buffer, private readonly resource: string) {
    if (key.length !== 32) throw Error('APPROVAL_CONFIG_INVALID');
    this.#key = Buffer.from(key);
  }
  async issue(raw: Approval, args: unknown, approvals: readonly Approval[], guard?: Guard, permit?: PolicyAuthorization): Promise<string> {
    const binding = bindingSchema.parse(raw);
    if (hash(args) !== binding.argsHash) throw Error('BINDING_MISMATCH');
    const decision = guard ? await guard({ ...binding, args: structuredClone(args), capabilities: permit ? [...(policyCapabilities(permit) ?? [])] : [], sideEffect: true }) : 'needs_approval';
    if (decision !== 'allow' && decision !== 'needs_approval') throw Error('TOOL_DENIED');
    const policy = permit ? policyBinding(permit) : undefined;
    if (permit && (!policy || canonical(policy) !== canonical(binding) || guard && decision !== 'allow')) throw Error('APPROVAL_REQUIRED');
    if (!policy && !approvals.some(a => canonical(a) === canonical(binding))) throw Error('APPROVAL_REQUIRED');
    const authorization = policy ? { source: 'policy', policyHash: permit!.policyHash } : { source: 'human' };
    const payload = Buffer.from(JSON.stringify({ binding, authorization, resource: this.resource, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.#key).update(payload).digest('base64url')}`;
  }
  verify(proof: unknown, tenant: string, tool: string, args: unknown): Approval {
    return this.verifyAuthorization(proof, tenant, tool, args).binding;
  }
  verifyAuthorization(proof: unknown, tenant: string, tool: string, args: unknown): { binding: Approval; authorization: z.infer<typeof authorizationSchema> } {
    try {
      if (typeof proof !== 'string' || proof.length > 4096) throw Error();
      const parts = proof.split('.'); if (parts.length !== 2) throw Error();
      const [payload, mac] = parts as [string, string];
      const expected = createHmac('sha256', this.#key).update(payload).digest();
      const actual = Buffer.from(mac, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { binding: unknown; resource: unknown; exp: unknown; authorization?: unknown };
      const binding = bindingSchema.parse(data.binding); const now = Date.now() / 1000;
      if (data.resource !== this.resource || typeof data.exp !== 'number' || !Number.isFinite(data.exp) || data.exp <= now || data.exp > now + 61 || binding.tenantId !== tenant || binding.tool !== tool || binding.argsHash !== hash(args)) throw Error();
      // Legacy signed proofs could only be minted after an exact human approval.
      const authorization = authorizationSchema.parse(data.authorization ?? { source: 'human' });
      return { binding, authorization };
    } catch { throw Error('APPROVAL_REQUIRED'); }
  }
}
