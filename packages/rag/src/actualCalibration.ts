import { readFileSync } from 'node:fs';
import artifactsJson from './calibrationArtifacts.json' with { type: 'json' };
import sourcePins from './calibrationSourcePins.json' with { type: 'json' };
import qaFreezeJson from '../../../data/rag/qa.freeze.json' with { type: 'json' };
import { canonical, hash, parseVerdict, prompts, RUBRIC, validLocalJudgeObservation } from '../../evals/src/judge.js';
import type { createJudge, IntentEvent, Sample } from '../../evals/src/judge.js';
import { calibrateAgentReference, agentReferenceReport, validateAgentLabels } from '../../evals/src/agentReference.js';
import type { AgentLabel } from '../../evals/src/agentReference.js';
import { agreement, pairLabels } from '../../evals/src/agreement.js';
import type { Labeled } from '../../evals/src/agreement.js';
import { sameLocalJudgeIdentity, validateLocalJudgeIdentity } from '../../models/src/localJudgeProfile.js';
import { OFFICIAL_CORPUS_VERSION } from './ingest.js';

export function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
// Pinned artifact sizes and hashes, never supplied by callers or inferred from favorable metrics.
const approved = freezeTree(artifactsJson);
freezeTree(sourcePins);
export const actualCalibrationRoles = Object.freeze(['task9V1','task9V2','task9Selection','task9Cohort',
  'task9PrimarySamples','task9SecondarySamples','task9SourceAudit','task9PrimaryReference',
  'task9SecondaryReference','task9ReferenceAudit','domainObservation','domainSamples',
  'domainReference','domainAudit','domainFreeze'] as const);
export type ActualCalibrationBundle = Readonly<Record<typeof actualCalibrationRoles[number], string>>;
const profile = validateLocalJudgeIdentity(approved.modelProfile);
export const GROUNDING_RUBRIC = freezeTree({ ...approved.domain.rubric });
export const GROUNDING_PROTOCOL = freezeTree({ ...approved.domain.protocol, localJudgeProfile: profile });
export const GROUNDING_PROTOCOL_HASH = approved.domain.protocolHash;
type Observation = Awaited<ReturnType<ReturnType<typeof createJudge>['observe']>>;
type Study = {
  schema: number; status: string; requestsAttempted: number; completed: number; failure?: unknown; unresolvedRequests?: number;
  implementationSha256: string; gitSha: string; human_evidence: boolean; reference_origin: string;
  intents: IntentEvent[]; observed: Observation[]; predictions: Labeled[];
};
function requireValue(value: unknown): asserts value { if (!value) throw new Error('INVALID_REVIEWED_CALIBRATION'); }
function equal(a: unknown, b: unknown) { requireValue(canonical(a) === canonical(b)); }
function lines<T>(raw: string): T[] { return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as T); }
function samplesById(samples: Sample[], expected: string[]) {
  const map = new Map(samples.map(sample => [sample.id, sample]));
  requireValue(map.size === expected.length && samples.length === expected.length && expected.every(id => map.has(id)));
  return map;
}
/** Historical whole-source fingerprints are retained; only relevant live protocol sources must still match. */
export function currentCalibrationSourcesMatch(): boolean {
  try { return sourcePins.every(pin => hash(readFileSync(new URL(pin.path, import.meta.url), 'utf8')) === pin.sha256); }
  catch { return false; }
}
function validateStudy(study: Study, samples: Map<string, Sample>, version: 'v1'|'v2', rubric: {version:string;text:string}, systemHash: string, seenRuns: Set<string>) {
  requireValue(study.status === 'completed' && study.completed === samples.size && study.requestsAttempted === samples.size
    && !study.failure && (study.unresolvedRequests === undefined || study.unresolvedRequests === 0)
    && study.human_evidence === false && study.reference_origin === 'subagent'
    && study.implementationSha256 === approved.historicalImplementationSha256
    && study.observed.length === samples.size && study.predictions.length === samples.size && study.intents.length === 2*samples.size);
  const observedIds = new Set<string>();
  const predictions = new Map(study.predictions.map(row => [row.id,row.label]));
  requireValue(predictions.size === samples.size && [...predictions.keys()].every(id => samples.has(id)));
  const pending = new Map<string, IntentEvent['intent']>();
  const completed = new Set<string>();
  for (const event of study.intents) {
    const intent = event.intent;
    requireValue(samples.has(intent.sampleId) && intent.sampleHash === hash(canonical(samples.get(intent.sampleId)))
      && intent.promptVersion === version && intent.promptHash === systemHash && intent.rubricHash === hash(canonical(rubric))
      && sameLocalJudgeIdentity(intent.localJudgeProfile, profile) && Number.isFinite(Date.parse(intent.preparedAt)));
    if (event.state === 'dispatch-intent') {
      requireValue(!seenRuns.has(intent.requestedRunId)); seenRuns.add(intent.requestedRunId);
      pending.set(intent.requestedRunId, intent);
    } else {
      requireValue(event.state === 'completed' && !event.failure && pending.has(intent.requestedRunId) && !completed.has(intent.requestedRunId));
      equal(pending.get(intent.requestedRunId), intent);
      const observation = study.observed.find(row => row.requestedRunId === intent.requestedRunId);
      requireValue(observation && Date.parse(intent.preparedAt) <= Date.parse(observation.observedAt));
      equal(event.observation, observation); completed.add(intent.requestedRunId);
    }
  }
  requireValue(completed.size === samples.size);
  for (const row of study.observed) {
    const sample = samples.get(row.sampleId);
    requireValue(sample && !observedIds.has(row.sampleId) && completed.has(row.requestedRunId)
      && validLocalJudgeObservation(row, profile) && row.sampleHash === hash(canonical(sample))
      && row.promptVersion === version && row.promptHash === systemHash && row.rubricVersion === rubric.version
      && row.rubricHash === hash(canonical(rubric)) && row.model === 'local' && row.temperature === 0 && row.seed === 0 && row.maxTokens === 1024
      && /^[0-9a-f]{64}$/.test(row.rawResponseHash) && Number.isFinite(Date.parse(row.observedAt)));
    requireValue(row.action.role === 'assistant' && row.action.toolCalls instanceof Array && !row.action.toolCalls.length
      && Object.keys(row.action).sort().join(',') === 'content,role,toolCalls');
    const verdict = parseVerdict(row.action.content as string);
    equal(verdict, row.verdict); equal(row.semanticHash, hash(canonical({ action: row.action, verdict })));
    equal(predictions.get(row.sampleId), verdict.label); observedIds.add(row.sampleId);
  }
}
/** No I/O to inference or references. Host loads the private raw files; every role has an exact byte commitment. */
export function verifyReviewedBundle(bundle: ActualCalibrationBundle) {
  requireValue(currentCalibrationSourcesMatch());
  for (const role of actualCalibrationRoles) {
    const raw = bundle[role], commitment = approved.files[role];
    requireValue(typeof raw === 'string' && Buffer.byteLength(raw) === commitment.bytes && hash(raw) === commitment.sha256);
  }
  const cohort = JSON.parse(bundle.task9Cohort) as {primaryIds:string[];secondaryIds:string[];cohortHash:string;primaryHash:string;secondaryHash:string;auditHash:string};
  requireValue(cohort.primaryIds.length === 300 && cohort.secondaryIds.length === 100);
  equal(cohort.primaryHash, approved.files.task9PrimarySamples.sha256); equal(cohort.secondaryHash, approved.files.task9SecondarySamples.sha256);
  equal(cohort.auditHash, approved.files.task9SourceAudit.sha256);
  const primarySamples = lines<Sample>(bundle.task9PrimarySamples), secondarySamples = lines<Sample>(bundle.task9SecondarySamples);
  const samples = samplesById(primarySamples, cohort.primaryIds); samplesById(secondarySamples, cohort.secondaryIds);
  for (const sample of secondarySamples) equal(samples.get(sample.id), sample);
  const inputHashes = new Map(bundle.task9PrimarySamples.split('\n').filter(Boolean).map(line => [(JSON.parse(line) as Sample).id, hash(line)]));
  const primary = validateAgentLabels(lines<AgentLabel>(bundle.task9PrimaryReference),cohort.primaryIds,cohort.cohortHash,RUBRIC.version,inputHashes);
  const secondary = validateAgentLabels(lines<AgentLabel>(bundle.task9SecondaryReference),cohort.secondaryIds,cohort.cohortHash,RUBRIC.version,inputHashes);
  const reference = agentReferenceReport(cohort.primaryIds,cohort.secondaryIds,primary,secondary);
  requireValue(reference.accepted_user_substitution); equal(reference.agreement,approved.task9.referenceAgreement);
  const referenceAudit = JSON.parse(bundle.task9ReferenceAudit);
  equal(referenceAudit.sourceHashes,{primary:approved.files.task9PrimaryReference.sha256,secondary:approved.files.task9SecondaryReference.sha256});
  equal(referenceAudit.agreement, reference.agreement);
  const seenRuns = new Set<string>(), predictions: Record<string,Labeled[]> = {};
  for (const version of ['v1','v2'] as const) {
    const raw = JSON.parse(bundle[version === 'v1' ? 'task9V1' : 'task9V2']);
    const identity = approved.task9.versions[version];
    requireValue(raw.schema === 2 && raw.gitSha === identity.executionGitSha && raw.cohortHash === cohort.cohortHash
      && raw.promptVersion === version && raw.promptText === prompts[version] && raw.promptHash === hash(prompts[version])
      && raw.promptHash === identity.basePromptHash && sameLocalJudgeIdentity(raw.localJudgeProfile, profile));
    equal(raw.rubric, RUBRIC); equal(raw.rubricHash, hash(canonical(RUBRIC)));
    equal(identity.fullSystemPromptHash, hash(`${prompts[version]}\nRubric ${RUBRIC.version}: ${RUBRIC.text}`));
    equal(raw.referenceSourceHashes,referenceAudit.sourceHashes); equal(raw.referenceAuditHash,hash(canonical(referenceAudit)));
    validateStudy({...raw,...raw.result},samples,version,RUBRIC,identity.fullSystemPromptHash,seenRuns);
    predictions[version] = raw.result.predictions;
  }
  const task9 = calibrateAgentReference(cohort.primaryIds,primary,predictions);
  equal(task9, approved.task9.calibration);
  const selection = JSON.parse(bundle.task9Selection);
  equal(selection.calibration,task9); equal(selection.judgeSourceHashes,{v1:approved.files.task9V1.sha256,v2:approved.files.task9V2.sha256});
  equal(selection.comparedImplementation,approved.historicalImplementationSha256); equal(selection.localJudgeProfile,profile);
  const domainSamples = lines<Sample>(bundle.domainSamples), domainIds = domainSamples.map(sample => sample.id);
  requireValue(domainSamples.length === 100);
  const domainMap = samplesById(domainSamples, domainIds);
  const domainCohort = hash(canonical([...domainSamples].sort((a,b)=>a.id.localeCompare(b.id))));
  const freeze = JSON.parse(bundle.domainFreeze);
  requireValue(freeze.cases === 100 && freeze.pairedFacts === 50 && freeze.documents === 17 && freeze.actualDomainJudgeCallsBeforeFreeze === 0
    && freeze.corpusVersion === OFFICIAL_CORPUS_VERSION && freeze.referenceOrigin === 'subagent' && freeze.human_evidence === false);
  equal(domainCohort,freeze.cohortHash);
  const domainReference = validateAgentLabels(lines<AgentLabel>(bundle.domainReference),domainIds,domainCohort,GROUNDING_RUBRIC.version,
    new Map(domainSamples.map(sample => [sample.id,hash(canonical(sample))])));
  const domain = JSON.parse(bundle.domainObservation);
  requireValue(domain.schema === 1 && domain.kind === 'task14-frozen-domain-diagnostic-v1' && domain.reliableJudgeAdmitted === false
    && domain.gitSha === approved.domain.executionGitSha);
  equal(domain.source.cohortHash,domainCohort); equal(domain.source.sampleSha256,approved.files.domainSamples.sha256); equal(domain.source.freezeSha256,approved.files.domainFreeze.sha256);
  equal(domain.selection.sha256,approved.files.task9Selection.sha256); equal(domain.selection.task9JudgeSourceHashes,selection.judgeSourceHashes); equal(domain.selection.task9Agreement,task9.versions);
  equal(domain.rubric,GROUNDING_RUBRIC); equal(domain.protocol,GROUNDING_PROTOCOL); equal(domain.protocolHash,hash(canonical(domain.protocol))); equal(domain.protocolHash,GROUNDING_PROTOCOL_HASH);
  equal(GROUNDING_PROTOCOL.basePromptHash,hash(prompts.v1)); equal(GROUNDING_PROTOCOL.rubricHash,hash(canonical(GROUNDING_RUBRIC)));
  equal(GROUNDING_PROTOCOL.systemPromptHash,hash(`${prompts.v1}\nRubric ${GROUNDING_RUBRIC.version}: ${GROUNDING_RUBRIC.text}`));
  validateStudy(domain,domainMap,'v1',GROUNDING_RUBRIC,GROUNDING_PROTOCOL.systemPromptHash,seenRuns);
  requireValue(domain.observed.every((row:Observation)=>Date.parse(freeze.frozenAt) < Date.parse(row.observedAt)));
  // One already-selected judge: descriptive agreement, no fabricated second comparator or quality threshold.
  const paired = pairLabels(domainReference,domain.predictions);
  const domainAgreement = agreement(paired.a,paired.b); equal(domainAgreement,approved.domain.agreement);
  return freezeTree({
    model:profile.configured.servedModel,revision:profile.configured.modelRevision,
    promptHash:GROUNDING_PROTOCOL.systemPromptHash,protocolHash:GROUNDING_PROTOCOL_HASH,rubricHash:GROUNDING_PROTOCOL.rubricHash,
    artifactHash:approved.files.task9Selection.sha256,domainValidationHash:approved.files.domainObservation.sha256,
    reliableJudgeAdmitted:false as const,
    quality:{task9,referenceAgreement:reference.agreement,referenceLimitations:reference.limitations,
      domain:{agreement:domainAgreement,diagnosticCounts:structuredClone(approved.domain.diagnosticCounts),limits:[...freeze.limitations] as string[]},limits:[...approved.limits]},
    historicalExecutions:{task9:{gitSha:approved.task9.versions.v1.executionGitSha,implementationSha256:approved.historicalImplementationSha256},domain:{gitSha:approved.domain.executionGitSha,implementationSha256:approved.historicalImplementationSha256}},
    studyBindings:{task9:{
      v1:{...approved.task9.versions.v1,rawSha256:approved.files.task9V1.sha256},
      v2:{...approved.task9.versions.v2,rawSha256:approved.files.task9V2.sha256},
    },domain:{...GROUNDING_PROTOCOL,protocolHash:GROUNDING_PROTOCOL_HASH,rawSha256:approved.files.domainObservation.sha256}},
    localJudgeProfile:profile,
  });
}

export function frozenQaCommitments(raw: string, auditRaw: string, freezeRaw: string) {
  for (const [text, commitment] of [[raw,approved.files.frozenQa],[auditRaw,approved.files.frozenQaAudit],[freezeRaw,approved.files.qaFreeze]] as const) {
    requireValue(Buffer.byteLength(text) === commitment.bytes && hash(text) === commitment.sha256);
  }
  const freeze = JSON.parse(freezeRaw) as {
    corpusVersion:string; human_evidence:false; human_gold:false; metric_runs_before_freeze:number;
    qa:{sha256:string;rows:number}; audit:{sha256:string;rows:number}; limits:string[];
    provenance:{origin:'agent';annotator:string;auditRef:string;inputHash:string}[];
  };
  requireValue(freeze.corpusVersion === OFFICIAL_CORPUS_VERSION && freeze.human_evidence === false && freeze.human_gold === false
    && freeze.metric_runs_before_freeze === 0 && freeze.qa.rows === 200 && freeze.audit.rows === 200
    && freeze.qa.sha256 === hash(raw) && freeze.audit.sha256 === hash(auditRaw));
  return freezeTree(freeze);
}

/** Import preserves row property order; this reconstructs the exact reviewed JSONL, including final LF. */
export function isFrozenQaPopulation(rows: unknown[]): boolean {
  return rows.length === 200 && hash(rows.map(row=>JSON.stringify(row)).join('\n')+'\n') === approved.files.frozenQa.sha256;
}

export function reviewedQaEvidence() {
  requireValue(hash(JSON.stringify(qaFreezeJson,null,2)+'\n') === approved.files.qaFreeze.sha256);
  return freezeTree({rawHash:approved.files.frozenQa.sha256,auditHash:approved.files.frozenQaAudit.sha256,freezeHash:approved.files.qaFreeze.sha256,
    human_evidence:false,human_gold:false,provenance:structuredClone(qaFreezeJson.provenance),limits:[...qaFreezeJson.limits]});
}
