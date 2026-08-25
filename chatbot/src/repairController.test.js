'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRepairDecision } = require('./repairController');

function candidate(overrides = {}) {
  return {
    behaviorFingerprint: 'behavior-v1',
    blockingFindingFingerprints: ['finding-a'],
    repairableBlockingFindingFingerprints: ['finding-a'],
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

test('permits one terminal repair only for a first-seen repairable blocking finding at the normal limit', () => {
  const first = candidate({ behaviorFingerprint: 'behavior-v1' });
  const second = candidate({ behaviorFingerprint: 'behavior-v2' });
  const third = candidate({
    behaviorFingerprint: 'behavior-v3',
    blockingFindingFingerprints: ['finding-a', 'finding-new'],
    repairableBlockingFindingFingerprints: ['finding-a', 'finding-new'],
  });
  const result = evaluateRepairDecision({ currentCandidate: third, history: [first, second] });

  assert.equal(result.action, 'repair');
  assert.equal(result.reason, 'terminal_repair_for_new_blocking_finding');
  assert.equal(result.terminalRepair.eligible, true);
  assert.deepEqual(result.terminalRepair.firstSeenRepairableBlockingFindingFingerprints, ['finding-new']);
});

test('the terminal repair cannot authorize a fifth candidate', () => {
  const result = evaluateRepairDecision({
    currentCandidate: candidate({
      behaviorFingerprint: 'behavior-v4',
      blockingFindingFingerprints: ['finding-a', 'finding-newer'],
      repairableBlockingFindingFingerprints: ['finding-a', 'finding-newer'],
    }),
    history: [
      candidate({ behaviorFingerprint: 'behavior-v1' }),
      candidate({ behaviorFingerprint: 'behavior-v2' }),
      candidate({ behaviorFingerprint: 'behavior-v3', blockingFindingFingerprints: ['finding-a', 'finding-new'], repairableBlockingFindingFingerprints: ['finding-a', 'finding-new'] }),
    ],
  });
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'repair_budget_exhausted');
  assert.equal(result.terminalRepair.eligible, false);
});

test('repeated, clarify, unsafe, timeout, and normalization-only states cannot authorize a terminal repair', () => {
  const history = [candidate({ behaviorFingerprint: 'behavior-v1' }), candidate({ behaviorFingerprint: 'behavior-v2' })];
  const terminalCandidate = candidate({
    behaviorFingerprint: 'behavior-v3',
    blockingFindingFingerprints: ['finding-a', 'finding-new'],
    repairableBlockingFindingFingerprints: ['finding-a', 'finding-new'],
  });
  const cases = [
    evaluateRepairDecision({ currentCandidate: candidate({ behaviorFingerprint: 'behavior-v1' }), history }),
    evaluateRepairDecision({ currentCandidate: terminalCandidate, history, findingSet: { findings: [finding('need-input', { action: 'clarify' })] } }),
    evaluateRepairDecision({ currentCandidate: terminalCandidate, history, policy: { maxLlmCandidates: 3, maxLlmRepairs: 2 }, elapsedMs: 360000 }),
    evaluateRepairDecision({ currentCandidate: candidate({ ...terminalCandidate, hasSafeRepairPath: false }), history }),
    evaluateRepairDecision({
      currentCandidate: candidate({ behaviorFingerprint: 'behavior-v3', blockingFindingFingerprints: ['normalization-only'], repairableBlockingFindingFingerprints: [] }),
      history,
      findingSet: { findings: [finding('normalization-only', { kind: 'deterministic_normalization_warning', blocking: false })] },
    }),
  ];
  for (const result of cases) assert.equal(result.terminalRepair.eligible, false);
  assert.deepEqual(cases.map((result) => result.action), ['stop', 'clarify', 'stop', 'stop', 'pass']);
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
