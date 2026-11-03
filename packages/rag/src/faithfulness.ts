import { randomUUID } from 'node:crypto';
import { createJudge, JudgeFailure, canonical, hash } from '../../evals/src/judge.js';
import type { IntentEvent } from '../../evals/src/judge.js';
import type { CallAccounting } from 'models/types';
import type { VerifiedCalibration } from './calibration.js';
import { isVerifiedCalibration } from './calibration.js';
import type { ScorerBinding } from './rerank.js';
import { currentCalibrationSourcesMatch, freezeTree, GROUNDING_PROTOCOL, GROUNDING_RUBRIC } from './actualCalibration.js';

export type ActualFaithfulnessOptions = {
  endpoint?: string;
  token: string;
  fetch?: typeof fetch;
  /** Trusted host contract: resolve only after durable persistence (including fsync/transaction commit).
   * Rejection prevents POST for dispatch-intent, and prevents successful return for completion.
   * A callback alone cannot prove disk durability; the host owns that implementation. */
  checkpoint: (event: IntentEvent) => Promise<void>;
};
function normalizedAccounting(raw: NonNullable<JudgeFailure['evidence']['accounting']>): CallAccounting {
  return {
    model:raw.model as string,provider:'openaiCompatible',status:raw.status as CallAccounting['status'],costStatus:raw.costStatus as CallAccounting['costStatus'],costUsd:raw.costUsd as number,
    ...(raw.usage === null ? {} : {usage:raw.usage}),
    ...('run_id' in raw && typeof raw.run_id === 'string' ? {run_id:raw.run_id,call_id:raw.call_id as string} : {}),
    attempts:raw.attempts.map(attempt=>({attempt:attempt.attempt as number,outcome:attempt.outcome as CallAccounting['status'],
      costStatus:attempt.costStatus as CallAccounting['costStatus'],...(attempt.costUsd === null ? {} : {costUsd:attempt.costUsd as number}),
      ...(attempt.usage === null ? {} : {usage:attempt.usage})})),
  };
}
export function actualFaithfulnessJudge(options: ActualFaithfulnessOptions, binding: ScorerBinding, calibration: VerifiedCalibration) {
  if (!isVerifiedCalibration(calibration) || calibration.scope !== 'actual' || calibration.model !== binding.model || calibration.revision !== binding.revision
    || !options || typeof options.checkpoint !== 'function' || binding.alias !== 'local' || !calibration.localJudgeProfile
    || (options.endpoint !== undefined && options.endpoint !== 'http://127.0.0.1:18080/v1/agent/step')
    || !currentCalibrationSourcesMatch()) return null;
  const config = { ...options };
  try { createJudge({token:config.token,...(config.endpoint === undefined ? {} : {endpoint:config.endpoint}),localJudgeProfile:calibration.localJudgeProfile}); }
  catch { return null; }
  binding = Object.freeze({ ...binding });
  const fetcher = config.fetch ?? fetch;
  return Object.freeze({
    binding,calibration,
    async score(question:string,contexts:{id:string;text:string}[],answer:string,signal:AbortSignal) {
      if (!question.trim() || !answer.trim() || !contexts.length || contexts.some(c=>!c.id || !c.text)) throw new Error('INVALID_FAITHFULNESS_INPUT');
      signal.throwIfAborted();
      if (!currentCalibrationSourcesMatch()) throw new Error('CALIBRATION_PROTOCOL_SOURCE_DRIFT');
      const input = structuredClone({question,contexts,answer});
      const sample = {id:randomUUID(),input:{question:input.question,contexts:input.contexts},action:{answer:input.answer}};
      let dispatched = false;
      const scopedFetch:typeof fetch = (url,init) => {
        signal.throwIfAborted();
        const combined = init?.signal ? AbortSignal.any([signal,init.signal]) : signal;
        if (init?.method === 'POST') dispatched = true;
        return fetcher(url,{...init,signal:combined});
      };
      const judge = createJudge({token:config.token,fetch:scopedFetch,localJudgeProfile:calibration.localJudgeProfile!,promptVersion:GROUNDING_PROTOCOL.selectedTask9PromptVersion as 'v1',
        ...(config.endpoint === undefined ? {} : {endpoint:config.endpoint})});
      const persist = async(event:IntentEvent) => {
        try { await config.checkpoint(freezeTree(structuredClone(event))); }
        catch { throw new Error('FAITHFULNESS_CHECKPOINT_FAILED'); }
      };
      // Per-call createJudge and scoped fetch keep caller cancellation independent, including preflight.
      await judge.verifyProfile(); signal.throwIfAborted();
      const intent = judge.prepare(sample,GROUNDING_RUBRIC);
      await persist({state:'dispatch-intent',intent});
      let observation:Awaited<ReturnType<typeof judge.observe>> | undefined;
      let completionPersisted = false;
      try {
        signal.throwIfAborted();
        observation = await judge.observe(sample,GROUNDING_RUBRIC,intent);
        await persist({state:'completed',intent,observation});
        completionPersisted = true;
        signal.throwIfAborted();
        return {score:observation.verdict.label === 'pass' ? 1 : 0,verdict:observation.verdict,observation,
          accounting:normalizedAccounting(observation.accounting!),inputHash:hash(JSON.stringify(input)),sampleHash:hash(canonical(sample)),calibrationHash:calibration.artifactHash};
      } catch (error) {
        const evidence = error instanceof JudgeFailure ? error.evidence : undefined;
        const accounting = observation?.accounting ? normalizedAccounting(observation.accounting)
          : evidence?.accounting ? normalizedAccounting(evidence.accounting)
          : dispatched ? {model:binding.model,provider:'openaiCompatible' as const,status:signal.aborted?'aborted' as const:'failed' as const,costStatus:'unknown' as const,costUsd:0,
            run_id:intent.requestedRunId,call_id:intent.requestedCallId,attempts:[{attempt:1,outcome:signal.aborted?'aborted' as const:'failed' as const,costStatus:'unknown' as const}]} : undefined;
        let checkpointStatus:'delivered'|'failed' = 'delivered';
        // A completion persistence error must preserve the completed physical call, not relabel its cost as unknown.
        if (!observation) {
          try { await persist({state:'failed',intent,...(error instanceof JudgeFailure ? {failure:{code:error.code,evidence:error.evidence}} : {})}); }
          catch { checkpointStatus = 'failed'; }
        } else if (!completionPersisted) checkpointStatus = 'failed';
        throw Object.assign(new Error(signal.aborted ? 'FAITHFULNESS_ABORTED' : error instanceof JudgeFailure ? error.code : 'FAITHFULNESS_CHECKPOINT_FAILED'),
          { ...(accounting ? {accounting} : {}),checkpointStatus,...(evidence ? {evidence} : {}),...(observation ? {observation} : {}) });
      }
    },
  });
}
