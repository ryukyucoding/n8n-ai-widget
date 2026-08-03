'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shadowRepairEnabled, observeShadowRepair } = require('./shadowObservation');

function report() {
  return {
    contract: { contractRevision: 1 },
    verification: {
      findings: [{
        ruleId: 'dataflow.code_reference.missing_node', category: 'dataflow', severity: 'repair',
        location: { codeNodeName: 'Private Node Name' }, message: 'Never log this message.', repairable: true,
      }],
    },
    repairDecision: {
      action: 'repair', reason: 'blocking_findings_require_repair',
      budgetSummary: { llmRepairsUsed: 0 }, progressSignals: { progressDetected: false },
    },
    summary: { candidateBehaviorFingerprint: 'a'.repeat(64) },
  };
}

function logger() {
  const calls = { info: [], warn: [] };
  return {
    calls,
    info: (...args) => calls.info.push(args),
    warn: (...args) => calls.warn.push(args),
  };
}

test('flag defaults false and does not invoke the shadow orchestrator', async () => {
  let called = 0;
  const result = await observeShadowRepair({
    enabled: shadowRepairEnabled(undefined),
    evaluateShadowRepair: async () => { called += 1; return report(); },
  });
  assert.equal(shadowRepairEnabled(undefined), false);
  assert.equal(shadowRepairEnabled('false'), false);
  assert.equal(shadowRepairEnabled('true'), true);
  assert.equal(called, 0);
  assert.deepEqual(result, { observed: false });
});

test('enabled observer calls once and logs only deidentified shadow fields', async () => {
  const log = logger();
  const userRequest = 'PRIVATE REQUEST: include no log';
  const candidate = { nodes: [{ name: 'Private Node Name', id: 'workflow-id-123', position: [20, 40], parameters: { apiKey: 'sk-live-secret' } }] };
  const verification = { workflow: candidate, findings: report().verification.findings };
  let received;
  const result = await observeShadowRepair({
    enabled: true,
    evaluateShadowRepair: async (input) => { received = input; return report(); },
    logger: log,
    operation: 'create', userRequest, plannerOutput: { generator_instruction: userRequest }, candidateWorkflow: candidate,
    verificationResult: verification, repairState: { history: [] }, now: 0,
  });
  assert.equal(result.observed, true);
  assert.equal(log.calls.info.length, 1);
  assert.equal(received.userRequest, userRequest);
  assert.equal(received.verificationResult, verification);
  const payload = log.calls.info[0][1];
  assert.equal(payload.event, 'shadow_repair_decision');
  assert.equal(payload.operation, 'create');
  assert.deepEqual(payload.findingStatistics, [{ ruleId: 'dataflow.code_reference.missing_node', category: 'dataflow', severity: 'repair', count: 1 }]);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /PRIVATE REQUEST|Private Node Name|workflow-id-123|sk-live-secret|Never log this message/);
});

test('orchestrator failures are a safe warning and do not change formal inputs', async () => {
  const log = logger();
  const candidate = { nodes: [{ name: 'Candidate', parameters: {} }] };
  const verification = { status: 'pass', workflow: candidate, findings: [] };
  const retryState = { attempt: 1, retries: 1 };
  const n8nPostPayload = { name: 'unchanged payload' };
  const apiResponse = { message: 'unchanged response' };
  const before = JSON.parse(JSON.stringify({ candidate, verification, retryState, n8nPostPayload, apiResponse }));
  const result = await observeShadowRepair({
    enabled: true,
    evaluateShadowRepair: async () => { throw new Error('sk-live-error-must-not-log'); },
    logger: log,
    operation: 'create', userRequest: 'private request', plannerOutput: {}, candidateWorkflow: candidate,
    verificationResult: verification, repairState: retryState, now: 0,
  });
  assert.deepEqual({ candidate, verification, retryState, n8nPostPayload, apiResponse }, before);
  assert.deepEqual(result, { observed: false, reason: 'evaluation_failed' });
  assert.equal(log.calls.warn.length, 1);
  assert.doesNotMatch(JSON.stringify(log.calls.warn[0][1]), /private request|sk-live-error-must-not-log/);
});
