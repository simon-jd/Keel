export type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolCallId?: string };
export type ToolDef = { name: string; description?: string; parameters: Record<string, unknown> };
export type ChatRequest = { model: string; messages: Message[]; tools?: ToolDef[]; temperature?: number; maxTokens?: number; seed?: number };
export type ToolCall = { id: string; name: string; args: unknown };
export type Usage = { input: number; output: number };
export type InvalidToolCall = { id: string; name: string; error: 'malformed_json' | 'unknown_tool'; args?: unknown };
export type ObserverStatus = 'delivered' | 'failed';
export type AccountingDelivery = { observerStatus?: ObserverStatus; accounting?: CallAccounting };
export type ResponseBytes = { encoding: 'base64'; data: string; receivedBytes: number; capturedBytes: number; truncated: boolean; textEncoding: 'utf-8' | 'invalid-utf-8' | 'undetermined' };
export type ProviderResponse = { raw: string | null; bytes?: ResponseBytes; complete?: boolean; httpStatus?: number; settlementStatus?: 'validated' | 'unknown'; dispatch?: { startedAtMonotonicMs: number; intervalMs: number | null } };
export type ChatChunk = AccountingDelivery & { text?: string; toolCallOrder?: string[]; toolCalls?: ToolCall[]; invalidToolCalls?: InvalidToolCall[]; usage?: Usage; providerResponse?: ProviderResponse };
export type StreamOptions = { signal: AbortSignal; run_id?: string; call_id?: string; commercialLogical?: number };
export interface ModelClient { readonly localJudgeProfile?: import('./localJudgeProfile.js').LocalJudgeIdentity; stream(req: ChatRequest, opts: StreamOptions): AsyncIterable<ChatChunk> }
export type Provider = 'openai' | 'anthropic' | 'openaiCompatible' | 'azureCommercial';
export type Pricing = { inputPerMillion: number; outputPerMillion: number };
export type JsonSchemaResponseFormat = {type:'json_schema';json_schema:{name:string;strict:true;schema:Record<string,unknown>}};
export type Route = { provider: Provider; endpoint: string; model: string; apiKey?: string; pricing?: Pricing; commercial?: object; responseFormat?: JsonSchemaResponseFormat; localJudge?: object };
export type AttemptAccounting = { attempt: number; outcome: 'success' | 'failed' | 'aborted'; costStatus: 'known' | 'unknown'; usage?: Usage; costUsd?: number };
export type CallAccounting = { run_id?: string; call_id?: string; model: string; provider: Provider; status: 'success' | 'failed' | 'aborted'; usage?: Usage; costUsd: number; costStatus: 'known' | 'unknown'; attempts: AttemptAccounting[] };
export type Observer = (accounting: CallAccounting) => void | Promise<void>;

/** Metadata only: never exposes credentials, route objects or prompt payloads. */
export type AttemptAdmission = { alias: string; model: string; provider: Provider; attempt: number; priorAttempts: AttemptAccounting[]; run_id?: string; call_id?: string };
