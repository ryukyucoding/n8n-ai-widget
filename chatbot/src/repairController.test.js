'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRepairDecision } = require('./repairController');

function candidate(overrides = {}) {
  return {
    behaviorFingerprint: 'behavior-v1',
    blockingFindingFingerprints: ['finding-a'],
    severity: 'high',
    contractCoverage: 0.4,
    ...overrides,
  };
}

function finding(fingerprint, overrides = {}) {
  return { fingerprint, kind: 'validation', blocking: true, ...overrides };
}

test('passes when blocking findings are empty', () => {
  const result = evaluateRepairDecision({ currentCandidate: candidate({ blockingFindingFingerprints: [] }) });
  assert.equal(result.action, 'pass');
  assert.equal(result.reason, 'no_blocking_findings');
  assert.equal(result.budgetSummary.llmRepairsUsed, 0);
});

test('returns clarify for a clarification finding', () => {
  const result = evaluateRepairDecision({
    currentCandidate: candidate(),
    findingSet: { findings: [finding('finding-a'), finding('need-user-input', { kind: 'clarification', action: 'clarify' })] },
  });
  assert.equal(result.action, 'clarify');
  assert.equal(result.reason, 'clarification_required');
  assert.deepEqual(result.normalizedMetadataSummary.clarificationFindingFingerprints, ['need-user-input']);
});

test('does not count deterministic port normalization warnings as blocking or repairs', () => {
  const result = evaluateRepairDecision({
    currentCandidate: candidate({ blockingFindingFingerprints: ['port-normalized'] }),
    findingSet: { findings: [finding('port-normalized', { kind: 'deterministic_normalization_warning', blocking: false })] },
  });
  assert.equal(result.action, 'pass');
  assert.equal(result.normalizedMetadataSummary.deterministicNormalizationWarningCount, 1);
  assert.equal(result.normalizedMetadataSummary.blockingFindingCount, 0);
  assert.equal(result.budgetSummary.llmRepairsUsed, 0);
});

test('stops on an identical behavior fingerprint and identical blocking findings', () => {
  const result = evaluateRepairDecision({
    currentCandidate: candidate(),
    history: [candidate()],
  });
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'repeated_candidate_state');
  assert.equal(result.progressSignals.repeatedCandidateState, true);
});

test('continues repair when topology may match but behavior changes and findings are resolved', () => {
  const result = evaluateRepairDecision({
    currentCandidate: candidate({ behaviorFingerprint: 'same-topology-different-code', blockingFindingFingerprints: ['finding-a'] }),
    history: [candidate({ behaviorFingerprint: 'same-topology-old-code', blockingFindingFingerprints: ['finding-a', 'finding-b'] })],
  });
  assert.equal(result.action, 'repair');
  assert.equal(result.progressSignals.behaviorChanged, true);
  assert.deepEqual(result.progressSignals.resolvedBlockingFindingFingerprints, ['finding-b']);
});

test('continues repair for a new finding when severity decreases or coverage increases', () => {
  const result = evaluateRepairDecision({
    currentCandidate: candidate({ behaviorFingerprint: 'behavior-v2', blockingFindingFingerprints: ['finding-a', 'finding-new'], severity: 'medium', contractCoverage: 0.8 }),
    history: [candidate({ severity: 'high', contractCoverage: 0.4 })],
  });
  assert.equal(result.action, 'repair');
  assert.equal(result.reason, 'blocking_findings_with_progress');
  assert.equal(result.progressSignals.severityDecreased, true);
  assert.equal(result.progressSignals.contractCoverageIncreased, true);
  assert.deepEqual(result.progressSignals.newBlockingFindingFingerprints, ['finding-new']);
});

test('stops when repair candidate budget or global duration is exhausted', () => {
  const budgetResult = evaluateRepairDecision({
    currentCandidate: candidate({ behaviorFingerprint: 'third-candidate' }),
    history: [candidate({ behaviorFingerprint: 'first-candidate' }), candidate({ behaviorFingerprint: 'second-candidate' })],
  });
  assert.equal(budgetResult.action, 'stop');
  assert.equal(budgetResult.reason, 'repair_budget_exhausted');

  const repairLimitResult = evaluateRepairDecision({
    currentCandidate: candidate({ behaviorFingerprint: 'second-candidate' }),
    history: [candidate({ behaviorFingerprint: 'first-candidate' })],
    policy: { maxLlmCandidates: 10, maxLlmRepairs: 1 },
  });
  assert.equal(repairLimitResult.action, 'stop');
  assert.equal(repairLimitResult.reason, 'repair_budget_exhausted');

  const timeoutResult = evaluateRepairDecision({ currentCandidate: candidate(), elapsedMs: 360000 });
  assert.equal(timeoutResult.action, 'stop');
  assert.equal(timeoutResult.reason, 'global_duration_exhausted');
});

test('stops when the caller reports no safe repair path', () => {
  const result = evaluateRepairDecision({ currentCandidate: candidate({ hasSafeRepairPath: false }) });
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'no_safe_repair_path');
});

test('C07 fan-out must-execute-before finding receives a repair decision', () => {
  const result = evaluateRepairDecision({
    currentCandidate: candidate({
      behaviorFingerprint: 'c07-fan-out-v1',
      blockingFindingFingerprints: ['code_dataflow:must_execute_before'],
      severity: 'high',
      contractCoverage: 0.5,
    }),
    findingSet: { findings: [finding('code_dataflow:must_execute_before', { kind: 'must_execute_before', code: 'code_dataflow' })] },
  });
  assert.equal(result.action, 'repair');
  assert.equal(result.reason, 'blocking_findings_require_repair');
  assert.equal(result.shadowEvent.shadowMode, true);
  assert.equal('rawWorkflow' in result.shadowEvent, false);
});
