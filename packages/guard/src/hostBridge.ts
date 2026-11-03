/** Private CPU benchmark host bridge. Every invocation is a fresh process; state is
 * atomically persisted before any original tool handler can execute. No argument logging. */
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash, actionKey } from '../../runtime/src/actions.js';
import type { Approval, SecurityState } from '../../runtime/src/types.js';
import { createGuard, type GuardOptions } from './policy.js';
import { planned } from './planExecute.js';
import { approvalMatches } from './approval.js';
import { benchmarkPolicy, provenanceModes, widenReadOnly, type Defense } from './benchmarkPolicy.js';
import { emptyProvenance, observeResult, untrustedFlows, type ProvenanceState } from './provenance.js';
type Config = { tenantId: string; runId: string; capabilities: string[]; tools: Record<string, { sideEffect: boolean }>; options?: GuardOptions; approvals?: Approval[]; benchmark?: { policy: Defense; taskHash: string; trustedText?: string } };
type State = { version: 1; configHash: string; security: SecurityState; seq: number; pending: Approval[]; values?: ProvenanceState };
try {
  const [configPath, statePath] = process.argv.slice(2);
  if (!configPath || !statePath) throw Error();
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  if (!config.tenantId || !config.runId || !Array.isArray(config.capabilities) || !config.tools) throw Error();
  const { approvals: _approvals, ...identity } = config;
  const configHash = hash(identity);
  const guard = config.benchmark ? benchmarkPolicy(config.benchmark.policy, {
    taskHash: config.benchmark.taskHash, capabilities: config.capabilities,
    plan: config.options?.plan ? [...config.options.plan] : (() => { throw Error('BENCHMARK_PLAN_REQUIRED'); })(), tools: config.tools,
  }) : createGuard(config.options);
  const input = JSON.parse(readFileSync(0, 'utf8')) as { op: string; tool?: string; args?: unknown; result?: unknown };
  const provenance = !!config.benchmark && provenanceModes.includes(config.benchmark.policy);
  if (provenance && typeof config.benchmark!.trustedText !== 'string') throw Error();
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as State : (() => {
    if (input.op !== 'init') throw Error();
    return { version: 1, configHash, security: guard.initialize(), seq: 0, pending: [] };
  })();
  if (state.version !== 1 || state.configHash !== configHash || !guard.validate(state.security) || !Number.isSafeInteger(state.seq) || state.seq < 0 || !Array.isArray(state.pending)) throw Error();
  // An interrupted original dispatch is ambiguous; a new host cannot reset/retry it.
  if (input.op === 'init' && state.pending.length) throw Error();
  let decision = 'allow'; let binding: Approval | undefined;
  if (input.op === 'preflight') {
    const tool = input.tool!; const spec = Object.hasOwn(config.tools, tool) ? config.tools[tool] : undefined;
    // No args hash/approval or reservation until original nested resolution and
    // validation complete. A denied containing tool cannot execute child calls.
    const capabilityEnabled = !config.benchmark || ['capability', 'all', 'all-prov'].includes(config.benchmark.policy);
    const declared = config.benchmark?.policy === 'all-prov' ? widenReadOnly(config.capabilities, config.tools) : config.capabilities;
    decision = spec && typeof spec.sideEffect === 'boolean' && (!capabilityEnabled || declared.includes(tool)) && planned(tool, state.security) ? 'allow' : 'deny';
  } else if (input.op === 'dispatch') {
    const tool = input.tool!; const spec = Object.hasOwn(config.tools, tool) ? config.tools[tool] : undefined;
    if (!spec || typeof spec.sideEffect !== 'boolean') decision = 'deny';
    else {
      binding = { tenantId: config.tenantId, runId: config.runId, tool, argsHash: hash(input.args), actionKey: actionKey(config.runId, state.seq, tool, input.args) };
      decision = guard.evaluate({ ...binding, args: input.args, capabilities: config.capabilities, sideEffect: spec.sideEffect }, state.security);
      // Value-level provenance: a call is held only if an argument carries an untrusted identifier
      // (writes: identifiers and bare tokens; reads: e-mail/URL/IBAN identifiers, e.g. fetching an injected URL).
      if (provenance && decision === 'allow' && untrustedFlows(input.args, config.benchmark!.trustedText!, state.values ?? emptyProvenance(), !spec.sideEffect).length) decision = 'needs_approval';
      if (decision === 'needs_approval' && approvalMatches(binding, config.approvals ?? [])) decision = 'allow';
      if (decision === 'allow') { state.seq++; state.pending.push(binding); }
    }
  } else if (input.op === 'observe') {
    const pending = state.pending.pop();
    if (!pending || pending.tool !== input.tool || pending.argsHash !== hash(input.args)) throw Error();
    state.security = guard.observe(state.security);
    if (provenance) state.values = observeResult(state.values ?? emptyProvenance(), input.result ?? null);
  } else if (input.op !== 'init') throw Error();
  const temporary = statePath + '.' + process.pid + '.tmp';
  const file = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(file, JSON.stringify(state)); fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, statePath);
  const directory = openSync(dirname(statePath), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  process.stdout.write(JSON.stringify({ decision, ...(binding ? { binding } : {}) }));
} catch { process.stdout.write('{"decision":"deny","error":"HOST_GUARD_FAILED"}'); process.exitCode = 1; }
