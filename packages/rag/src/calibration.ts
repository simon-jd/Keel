import { compareLabels, validateHumanLabels } from '../../evals/src/calibration.js';
import { validateAgentLabels } from '../../evals/src/agentReference.js';
import type { AttributedLabel } from '../../evals/src/calibration.js';
import type { AgentLabel } from '../../evals/src/agentReference.js';
import type { Labeled } from '../../evals/src/agreement.js';
import { canonical, hash } from '../../evals/src/judge.js';
import { OFFICIAL_CORPUS_VERSION, sha256 } from './ingest.js';
import { verifyReviewedBundle } from './actualCalibration.js';
import type { ActualCalibrationBundle } from './actualCalibration.js';
export type { ActualCalibrationBundle } from './actualCalibration.js';

export type GroundingProtocol = { model: string; revision: string; promptHash: string; protocolHash: string; rubricHash: string };
type Observation = GroundingProtocol & { id: string; version: string; sampleHash: string; label: 'pass' | 'fail' };
type Sample = { id: string; input: { question: string; contexts: { id: string; text: string }[] }; action: { answer: string } };
export type CalibrationArtifact = GroundingProtocol & {
  schema: 1;
  scope: 'fixture' | 'actual';
  kind: 'task9-calibration' | 'kubernetes-grounding-validation';
  referenceOrigin: 'human' | 'subagent';
  human_evidence: boolean;
  cohortHash: string;
  rubricVersion: string;
  samples: Sample[];
  reference: (AttributedLabel | AgentLabel)[];
  predictions: Record<string, Labeled[]>;
  records: Observation[];
  comparison: ReturnType<typeof compareLabels>;
  corpusVersion?: string;
  task9ArtifactHash?: string;
};
type Approval = GroundingProtocol & {
  scope: 'fixture' | 'actual';
  task9ArtifactHash: string;
  domainArtifactHash: string;
  referenceOrigin: 'human' | 'subagent';
  task9Ids: string[];
  domainIds: string[];
};
export type FixtureCalibrationApproval = Omit<Approval, 'scope'> & { purpose: 'synthetic-unit-test' };
export type VerifiedCalibration = Readonly<GroundingProtocol & {
  scope: 'fixture' | 'actual';
  source: 'task9';
  artifactHash: string;
  domainValidationHash: string;
  referenceOrigin: 'human' | 'subagent';
  human_evidence: boolean;
  reliableJudgeAdmitted?: false;
  quality?: ReturnType<typeof verifyReviewedBundle>['quality'];
  historicalExecutions?: ReturnType<typeof verifyReviewedBundle>['historicalExecutions'];
  studyBindings?: ReturnType<typeof verifyReviewedBundle>['studyBindings'];
  localJudgeProfile?: ReturnType<typeof verifyReviewedBundle>['localJudgeProfile'];
}>;
const receipts = new WeakSet<object>();

function validateArtifact(raw: string, expectedHash: string, approval: Approval, kind: CalibrationArtifact['kind'], ids: string[]) {
  if (sha256(raw) !== expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('UNAPPROVED_CALIBRATION_BYTES');
  const artifact = JSON.parse(raw) as CalibrationArtifact;
  if (artifact.schema !== 1 || artifact.scope !== approval.scope || artifact.kind !== kind
    || artifact.referenceOrigin !== approval.referenceOrigin || artifact.human_evidence !== (approval.referenceOrigin === 'human')
    || !ids.length || artifact.model !== approval.model || artifact.revision !== approval.revision
    || artifact.promptHash !== approval.promptHash || artifact.protocolHash !== approval.protocolHash
    || artifact.rubricHash !== approval.rubricHash) throw new Error('CALIBRATION_IDENTITY_MISMATCH');
  if (artifact.cohortHash !== hash(canonical(artifact.samples))) throw new Error('CALIBRATION_SAMPLE_MISMATCH');
  const samples = new Map(artifact.samples.map(sample => [sample.id, sample]));
  if (samples.size !== ids.length || artifact.samples.length !== ids.length || ids.some(id => !samples.has(id))) throw new Error('CALIBRATION_COVERAGE');
  const inputHashes = new Map(artifact.samples.map(sample => [sample.id, hash(canonical(sample))]));
  if (approval.referenceOrigin === 'human') validateHumanLabels(artifact.reference, ids, artifact.cohortHash, artifact.rubricVersion);
  else validateAgentLabels(artifact.reference, ids, artifact.cohortHash, artifact.rubricVersion, inputHashes);
  const comparison = compareLabels(ids, artifact.reference, artifact.predictions);
  if (comparison.status !== 'compared' || !comparison.selected || canonical(comparison) !== canonical(artifact.comparison)) throw new Error('INCOMPLETE_CALIBRATION');
  const expected = new Set(Object.keys(artifact.predictions).flatMap(version => ids.map(id => version + ':' + id)));
  if (artifact.records.length !== expected.size) throw new Error('CALIBRATION_RECORD_COVERAGE');
  for (const record of artifact.records) {
    const key = record.version + ':' + record.id;
    const prediction = artifact.predictions[record.version]?.find(row => row.id === record.id);
    if (!expected.delete(key) || record.sampleHash !== inputHashes.get(record.id) || record.label !== prediction?.label
      || record.model !== approval.model || record.revision !== approval.revision
      || record.promptHash !== approval.promptHash || record.protocolHash !== approval.protocolHash
      || record.rubricHash !== approval.rubricHash) throw new Error('CALIBRATION_RECORD_MISMATCH');
  }
  if (expected.size) throw new Error('CALIBRATION_RECORD_COVERAGE');
  if (kind === 'kubernetes-grounding-validation') {
    if (artifact.corpusVersion !== OFFICIAL_CORPUS_VERSION || artifact.task9ArtifactHash !== approval.task9ArtifactHash) throw new Error('DOMAIN_CALIBRATION_BINDING');
    for (const sample of artifact.samples) {
      if (typeof sample.input.question !== 'string' || !sample.input.question.trim()
        || !sample.input.contexts.length || sample.input.contexts.some(context => !context.id || !context.text)
        || typeof sample.action.answer !== 'string' || !sample.action.answer.trim()) throw new Error('DOMAIN_RECORD_BINDING');
    }
  }
  return artifact;
}
function verifyArtifacts(task9Raw: string, domainRaw: string, approval: Approval): VerifiedCalibration | null {
  try {
    validateArtifact(task9Raw, approval.task9ArtifactHash, approval, 'task9-calibration', approval.task9Ids);
    validateArtifact(domainRaw, approval.domainArtifactHash, approval, 'kubernetes-grounding-validation', approval.domainIds);
    const receipt = Object.freeze({ scope: approval.scope, source: 'task9' as const, model: approval.model, revision: approval.revision,
      promptHash: approval.promptHash, protocolHash: approval.protocolHash, rubricHash: approval.rubricHash,
      artifactHash: approval.task9ArtifactHash, domainValidationHash: approval.domainArtifactHash,
      referenceOrigin: approval.referenceOrigin, human_evidence: approval.referenceOrigin === 'human' });
    receipts.add(receipt);
    return receipt;
  } catch { return null; }
}
export function verifyFaithfulnessCalibration(bundle: Partial<ActualCalibrationBundle> | string, _legacyDomainRaw?: string): VerifiedCalibration | null {
  // The historical two-summary interface cannot establish actual reviewed provenance.
  if (typeof bundle === 'string') return null;
  try {
    const verified = verifyReviewedBundle(bundle as ActualCalibrationBundle);
    const receipt = Object.freeze({ ...verified, scope: 'actual' as const, source: 'task9' as const,
      referenceOrigin: 'subagent' as const, human_evidence: false });
    receipts.add(receipt);
    return receipt;
  } catch { return null; }
}
/** Explicit synthetic verifier only: its receipt cannot authorize an actual evaluation. */
export function verifyFixtureFaithfulnessCalibration(task9Raw: string, domainRaw: string, approval: FixtureCalibrationApproval): VerifiedCalibration | null {
  if (approval.purpose !== 'synthetic-unit-test') return null;
  return verifyArtifacts(task9Raw, domainRaw, { ...approval, scope: 'fixture' });
}
export function isVerifiedCalibration(value: unknown): value is VerifiedCalibration {
  return typeof value === 'object' && value !== null && receipts.has(value);
}
