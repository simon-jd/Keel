/** Trusted operator-only Azure BFCL admission. No keys/configuration accepted from HTTP. */
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import type { ChatRequest, Route, Usage } from './types.js';
import { ModelError, openaiMessages } from './protocol.js';
import { azureJudgeBody, judgePolicy, prepareJudgeProfile } from './azureJudgeProfile.js';
import { createJudgePacer } from './judgePacing.js';
import type { JudgeDispatchTiming } from './judgePacing.js';
import type { JudgeBinding } from './azureJudgeProfile.js';

export type CommercialBinding = { endpoint: string; deployment: string; model: string; version: string; region: string; sku: string; quote_id: string; request_hashes: string[] };
export type CommercialConfig = { ledger: string; reservationId: string; keyFile: string; binding: CommercialBinding; inputPerMillion: string; outputPerMillion: string };
export type JudgeCommercialConfig = Omit<CommercialConfig, 'binding'> & { binding: JudgeBinding };
type Guard = { config: CommercialConfig | JudgeCommercialConfig; claimToken: string; key: string; pace?: ReturnType<typeof createJudgePacer> };
const guards = new WeakMap<object, Guard>();
const script = fileURLToPath(new URL('../../../scripts/budget.py', import.meta.url));
const project = fileURLToPath(new URL('../../../', import.meta.url));
function deny(): never { throw new ModelError('invalid_request'); }
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) deny();
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
/** This exact serializer is shared by offline population preparation and paid dispatch. */
export function azureBody(req: ChatRequest, deployment: string): Record<string, unknown> {
  fields(req, ['model', 'messages', 'tools', 'temperature', 'seed', 'maxTokens']);
  if (req.model !== 'local' || req.seed !== 0 || req.temperature !== 0 || req.maxTokens !== 2048 || !Array.isArray(req.messages) || !req.messages.length) deny();
  for (const m of req.messages) {
    fields(m, ['role', 'content', 'toolCallId', 'toolCalls']);
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string') deny();
    if (m.toolCallId !== undefined && typeof m.toolCallId !== 'string') deny();
    if (m.toolCalls !== undefined) {
      if (!Array.isArray(m.toolCalls)) deny();
      for (const c of m.toolCalls) { fields(c, ['id', 'name', 'args']); if (typeof c.id !== 'string' || typeof c.name !== 'string') deny(); }
    }
  }
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) deny();
    for (const t of req.tools) {
      fields(t, ['name', 'description', 'parameters']);
      if (typeof t.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(t.name) || (t.description !== undefined && typeof t.description !== 'string') || !t.parameters || typeof t.parameters !== 'object' || Array.isArray(t.parameters)) deny();
    }
  }
  const body = { model: deployment, messages: openaiMessages(req), stream: true, stream_options: { include_usage: true }, n: 1, max_completion_tokens: 2048, temperature: 0, seed: 0,
    ...(req.tools === undefined ? {} : { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, parameters: t.parameters, ...(t.description === undefined ? {} : { description: t.description }) } })) }) };
  try { if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 32768) deny(); } catch { deny(); }
  return body;
}
export function bindingHash(binding: CommercialBinding | JudgeBinding): string {
  return createHash('sha256').update(canonical(binding)).digest('hex');
}
export function requestHash(req: ChatRequest, deployment: string): string {
  return createHash('sha256').update(JSON.stringify(azureBody(req, deployment))).digest('hex');
}
/** Trusted credential loading only: keys never enter API results or observability. */
export function readPrivateCredential(path: string): string {
  let fd: number | undefined;
  try {
    const absolute = resolve(path); const inside = relative(resolve(project, '.secrets'), absolute);
    if (inside.startsWith('..') || inside === '' || realpathSync(absolute) !== absolute) throw new Error();
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) throw new Error();
    const value = readFileSync(fd, 'utf8').trim();
    if (!value || /[\r\n\x00]/.test(value)) throw new Error();
    return value;
  } catch { throw new ModelError('configuration'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
async function rpc(config: CommercialConfig | JudgeCommercialConfig, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('python3', [script, '--ledger', config.ledger, 'phase' in config.binding ? 'judge-commercial-rpc' : 'commercial-rpc'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let output = ''; let stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill(); reject(new ModelError('budget_denied')); }, 10000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 4096) { stopped = true; child.kill(); } });
    child.on('error', () => { clearTimeout(timer); reject(new ModelError('budget_denied')); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output) as Record<string, unknown>;
        if (stopped || code !== 0 || result.error) throw new ModelError(result.error === 'budget_exhausted' ? 'budget_exhausted' : 'budget_denied');
        resolveResult(result);
      } catch (error) { reject(error instanceof ModelError ? error : new ModelError('budget_denied')); }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ ...data, reservation_id: config.reservationId }));
  });
}
export async function createAzureCommercialRoute(input: CommercialConfig): Promise<Route> {
  const config = structuredClone(input);
  const b = config.binding;
  if (!b || !/^https:\/\/[a-z0-9][a-z0-9-]{1,62}\.openai\.azure\.com\/openai\/v1$/.test(b.endpoint) || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.deployment) || b.model !== 'gpt-4.1-mini' || b.version !== '2025-04-14' || !['eastus', 'westus'].includes(b.region) || b.sku !== 'GlobalStandard' || !b.quote_id || !Array.isArray(b.request_hashes) || b.request_hashes.length < 1 || b.request_hashes.length > 10 || b.request_hashes.some(h => !/^[0-9a-f]{64}$/.test(h))) throw new ModelError('configuration');
  const key = readPrivateCredential(config.keyFile);
  const claimed = await rpc(config, { action: 'claim', binding: b });
  if (typeof claimed.claim_token !== 'string' || Number(claimed.input_per_million) !== Number(config.inputPerMillion) || Number(claimed.output_per_million) !== Number(config.outputPerMillion)) throw new ModelError('budget_denied');
  const commercial = {};
  guards.set(commercial, { config, claimToken: claimed.claim_token, key });
  return { provider: 'azureCommercial', endpoint: b.endpoint, model: b.deployment, pricing: { inputPerMillion: Number(config.inputPerMillion), outputPerMillion: Number(config.outputPerMillion) }, commercial };
}
/** Distinct trusted Task9 admission. Source/implementation are reconstructed, never self-attested. */
export async function createAzureJudgeRoute(input: JudgeCommercialConfig): Promise<Route> {
  const config = structuredClone(input);
  let expected: JudgeBinding;
  try { expected = prepareJudgeProfile(config.binding.quote_id, config.binding.quoteHash).binding; }
  catch { throw new ModelError('configuration'); }
  if (canonical(config.binding) !== canonical(expected)) throw new ModelError('configuration');
  const key = readPrivateCredential(config.keyFile);
  const claimed = await rpc(config, { action: 'claim', binding: config.binding });
  if (typeof claimed.claim_token !== 'string' || Number(claimed.input_per_million) !== Number(config.inputPerMillion) || Number(claimed.output_per_million) !== Number(config.outputPerMillion)) throw new ModelError('budget_denied');
  const commercial = {};
  guards.set(commercial, { config, claimToken: claimed.claim_token, key, pace: createJudgePacer() });
  return { provider: 'azureCommercial', endpoint: config.binding.endpoint, model: config.binding.deployment, pricing: { inputPerMillion: Number(config.inputPerMillion), outputPerMillion: Number(config.outputPerMillion) }, commercial };
}
export function isAzureJudgeRoute(route: Route): boolean {
  return !!(route.commercial && guards.get(route.commercial)?.config.binding && 'phase' in guards.get(route.commercial)!.config.binding);
}
export async function pacedJudgeFetch(route: Route, start: (timing: JudgeDispatchTiming) => Promise<Response>): Promise<Response> {
  const g = guard(route);
  if (!g.pace || !isAzureJudgeRoute(route)) throw new ModelError('budget_denied');
  return g.pace(start);
}
/** Reserve both the identity and host, including callers that mislabel the provider. */
export function assertProtectedJudgeRoute(route: Route, alias?: string): void {
  if (alias === 'azureJudge' || new URL(route.endpoint).hostname === new URL(judgePolicy.endpoint).hostname) {
    guard(route);
    if (!isAzureJudgeRoute(route)) throw new ModelError('budget_denied');
  }
}
export function assertCommercialAlias(route: Route, alias: string): void {
  guard(route);
  if (isAzureJudgeRoute(route) && alias !== 'azureJudge') throw new ModelError('configuration');
}
export function azureDispatchBody(req: ChatRequest, route: Route): Record<string, unknown> {
  guard(route);
  return isAzureJudgeRoute(route) ? azureJudgeBody(req) : azureBody(req, route.model);
}
function guard(route: Route): Guard {
  const value = route.commercial && guards.get(route.commercial);
  if (!value || route.endpoint !== value.config.binding.endpoint || route.model !== value.config.binding.deployment || route.provider !== 'azureCommercial' || route.apiKey !== undefined || route.pricing?.inputPerMillion !== Number(value.config.inputPerMillion) || route.pricing?.outputPerMillion !== Number(value.config.outputPerMillion)) throw new ModelError('budget_denied');
  return value;
}
export function assertCommercialRoute(route: Route): void { guard(route); }
export async function authorizeAzureDispatch(route: Route, path: string, body: unknown, logical?: number): Promise<{ key: string; attempt: number }> {
  const g = guard(route);
  if (path !== 'chat/completions') deny();
  const raw = JSON.stringify(body);
  const hash = createHash('sha256').update(raw).digest('hex');
  let result: Record<string, unknown>;
  if ('phase' in g.config.binding) {
    const binding = g.config.binding;
    let expected: JudgeBinding;
    try { expected = prepareJudgeProfile(binding.quote_id, binding.quoteHash).binding; } catch { throw new ModelError('budget_denied'); }
    if (binding.phase !== judgePolicy.phase || canonical(binding) !== canonical(expected) || !Number.isSafeInteger(logical) || binding.jobs[logical!]?.requestHash !== hash || Buffer.byteLength(raw, 'utf8') > 3072) deny();
    result = await rpc(g.config, { action: 'consume', claim_token: g.claimToken, binding_sha256: bindingHash(binding), logical, request_hash: hash });
  } else {
    if (Buffer.byteLength(raw, 'utf8') > 32768 || !g.config.binding.request_hashes.includes(hash)) deny();
    result = await rpc(g.config, { action: 'consume', claim_token: g.claimToken, binding: g.config.binding, request_hash: hash });
  }
  return { key: g.key, attempt: result.attempt as number };
}
export async function settleAzureDispatch(route: Route, attempt: number, usage?: Usage, outcome: 'valid' | 'invalid-schema' | 'failed' = 'failed'): Promise<void> {
  const g = guard(route);
  await rpc(g.config, { action: 'settle', claim_token: g.claimToken, attempt, usage: usage ?? null, ...('phase' in g.config.binding ? { outcome } : {}) });
}
