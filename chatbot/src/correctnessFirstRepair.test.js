'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPAIR_POLICY,
  createCandidateLimit,
  buildCorrectnessFirstRepairPrompt,
  repairControllerLogPayload,
  evaluateCorrectnessFirstRepair,
  decideCreateCandidateRetry,
} = require('./correctnessFirstRepair');

function finding(overrides = {}) {
  return {
    ruleId: 'dataflow.code_reference.must_execute_before', category: 'dataflow', severity: 'repair',
    location: { kind: 'code_reference', codeNodeName: 'must-not-log' }, repairable: true, normalized: false,
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    contract: { contractRevision: 1 },
    verification: { findings: [finding()] },
    repairDecision: {
      action: 'repair', reason: 'blocking_findings_require_repair',
      budgetSummary: { llmCandidatesUsed: 1, maxLlmCandidates: 3, llmRepairsUsed: 0, maxLlmRepairs: 2 },
      progressSignals: { repeatedCandidateState: false },
    },
    summary: { candidateBehaviorFingerprint: 'a'.repeat(64) },
    ...overrides,
  };
}

test('flag false retains the configured three-candidate limit and never calls the controller', async () => {
  let calls = 0;
  const result = await evaluateCorrectnessFirstRepair({
    enabled: false,
    evaluateShadowRepair: async () => { calls += 1; return report(); },
  });
  assert.equal(createCandidateLimit(false, 3), 3);
  assert.equal(result.action, 'legacy');
  assert.equal(calls, 0);
});

test('flag false stops after at most three candidates', async () => {
  let calls = 0;
  const actions = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await decideCreateCandidateRetry({
      correctnessFirstEnabled: false,
      attempt,
      legacyMaxCandidates: 3,
      evaluateCorrectnessFirstRepair: async () => { calls += 1; return report(); },
    });
    actions.push(result.action);
  }
  assert.deepEqual(actions, ['retry', 'retry', 'stop', 'stop']);
  assert.equal(calls, 0);
});

test('enabled mode reserves one terminal loop slot beyond the normal repair budget', async () => {
  const first = report();
  const second = report({
    repairDecision: { ...report().repairDecision, reason: 'blocking_findings_with_progress', budgetSummary: { llmCandidatesUsed: 2, maxLlmCandidates: 3, llmRepairsUsed: 1, maxLlmRepairs: 2 } },
    summary: { candidateBehaviorFingerprint: 'b'.repeat(64) },
  });
  const reports = [first, second];
  const outcomes = [];
  for (const item of reports) {
    outcomes.push(await evaluateCorrectnessFirstRepair({ enabled: true, evaluateShadowRepair: async () => item }));
  }
  assert.equal(createCandidateLimit(true, 3), 4);
  assert.equal(REPAIR_POLICY.maxLlmRepairs, 2);
  assert.ok(outcomes.every((outcome) => outcome.action === 'repair' && outcome.repairPrompt));
  assert.notEqual(outcomes[0].report.summary.candidateBehaviorFingerprint, outcomes[1].report.summary.candidateBehaviorFingerprint);
});

test('repeated state, clarification, unsafe path, exhausted budget, and timeout do not permit another candidate', async () => {
  for (const [action, reason] of [
    ['stop', 'repeated_candidate_state'], ['clarify', 'clarification_required'], ['stop', 'no_safe_repair_path'],
    ['stop', 'repair_budget_exhausted'], ['stop', 'global_duration_exhausted'],
  ]) {
    const result = await evaluateCorrectnessFirstRepair({
      enabled: true,
      evaluateShadowRepair: async () => report({ repairDecision: { ...report().repairDecision, action, reason } }),
    });
    assert.equal(result.action, action);
    assert.equal(result.repairPrompt, null);
  }
});

test('normalization warnings do not consume repair budget and improved Code behavior remains repairable', async () => {
  const result = await evaluateCorrectnessFirstRepair({
    enabled: true,
    evaluateShadowRepair: async () => report({
      verification: { findings: [finding({ ruleId: 'connection.port.target_input.normalized', category: 'connection', severity: 'warning', normalized: true, repairable: false })] },
      repairDecision: {
        action: 'repair', reason: 'blocking_findings_with_progress',
        budgetSummary: { llmCandidatesUsed: 2, maxLlmCandidates: 3, llmRepairsUsed: 1, maxLlmRepairs: 2 },
        progressSignals: { behaviorChanged: true, resolvedBlockingFindingFingerprints: ['prior-finding'] },
      },
      summary: { candidateBehaviorFingerprint: 'c'.repeat(64) },
    }),
  });
  assert.equal(result.action, 'repair');
  assert.equal(result.report.repairDecision.budgetSummary.llmRepairsUsed, 1);
  assert.match(result.repairPrompt, /must-execute-before/);
});

test('repair prompt reuses contract revision and log payload excludes names, workflow, and secrets', async () => {
  const result = await evaluateCorrectnessFirstRepair({ enabled: true, evaluateShadowRepair: async () => report() });
  assert.match(result.repairPrompt, /revision 1/);
  const payload = repairControllerLogPayload({ operation: 'create', report: result.report, timestamp: '2026-01-01T00:00:00.000Z' });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /must-not-log|workflow|sk-live|secret/i);
  assert.equal(payload.event, 'repair_controller_decision');
});

test('controller exceptions become a safe fallback and do not mutate formal inputs', async () => {
  const candidate = { nodes: [{ name: 'unchanged', parameters: {} }] };
  const verification = { findings: [] };
  const state = { history: [] };
  const before = JSON.parse(JSON.stringify({ candidate, verification, state }));
  const result = await evaluateCorrectnessFirstRepair({
    enabled: true, evaluateShadowRepair: async () => { throw new Error('secret error'); },
    candidateWorkflow: candidate, verificationResult: verification, repairState: state,
  });
  assert.deepEqual({ candidate, verification, state }, before);
  assert.deepEqual(result, { enabled: true, action: 'fallback', reason: 'evaluation_failed' });
});
