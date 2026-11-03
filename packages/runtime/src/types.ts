import type { CallAccounting, Message, ModelClient, ObserverStatus } from 'models/types';
import type { Tool } from './tools.js';
import type { PostgresStore } from './store.js';
export type Task = { tenantId: string; input: string; model: string; capabilities: string[] };
export type Budget = { modelCalls: number; toolCalls: number };
export type Approval = { tenantId: string; runId: string; tool: string; actionKey: string; argsHash: string };
export type ErrorCode = 'INVALID_INPUT' | 'RUN_BUSY' | 'RUN_INPUT_MISMATCH' | 'STORE_ERROR' | 'CANCELLED' | 'MODEL_ERROR' | 'INVALID_MODEL_RESPONSE' | 'INVALID_TOOL_ARGS' | 'UNKNOWN_TOOL' | 'TOOL_DENIED' | 'TOOL_ERROR' | 'ACTION_UNKNOWN' | 'BUDGET_EXCEEDED' | 'APPROVAL_REQUIRED';
export type RunCost = { status: 'known' | 'unknown'; knownUsd: number; totalUsd: number | null };
export type RunResult = { cost?: RunCost; status: 'DONE' | 'FAILED' | 'BUDGET_EXCEEDED' | 'NEEDS_APPROVAL'; budget: Budget; output?: string; errorCode?: ErrorCode; approval?: Approval };
export type GuardRequest = Approval & { readonly args: unknown; capabilities: readonly string[]; sideEffect: boolean };
export type SecurityState = { version: 1; policyHash: string; observed: boolean; plan: string[] | null };
export type SecurityPolicy = {
  readonly policyHash: string;
  initialize(): SecurityState;
  validate(state: SecurityState): boolean;
  observe(state: SecurityState): SecurityState;
  evaluate(request: GuardRequest, state: SecurityState): 'allow' | 'deny' | 'needs_approval';
};
export type Deps = { store: PostgresStore; model: ModelClient; tools: Tool[]; budget?: Partial<Budget>; signal?: AbortSignal; approvals?: readonly Approval[]; guard?: (request: GuardRequest) => Promise<'allow' | 'deny' | 'needs_approval'>; policyVersion?: string; security?: SecurityPolicy };
export type PendingCall = { id: string; name: string; args: unknown; seq: number };
export type Checkpoint = {
  security?: SecurityState;
  version: 1; fingerprint: string; limits: Budget; used: Budget; messages: Message[];
  nextSeq: number; corrections: number; pending: PendingCall[];
  deliveries: { callId: string; observerStatus?: ObserverStatus; accounting?: CallAccounting }[];
  result?: RunResult;
};
