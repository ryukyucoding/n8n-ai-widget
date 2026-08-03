'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAcceptanceContract } = require('./acceptanceContract');
const { verifyCandidateWorkflow } = require('./candidateWorkflowVerifier');
const { evaluateShadowRepair } = require('./shadowRepairOrchestrator');
const {
  createCandidateLimit,
  decideCreateCandidateRetry,
  evaluateCorrectnessFirstRepair,
  repairControllerLogPayload,
} = require('./correctnessFirstRepair');

const REQUEST = 'Produce the requested aggregate from two required upstream sources.';
const RUNTIME_SCHEMAS = {
  'test.source': { versions: { '1': { inputs: [] } } },
  'test.step': { versions: { '1': { inputs: ['main'] } } },
  'n8n-nodes-base.code': { versions: { '1': { inputs: ['main'] } } },
};

function plannerOutput() {
  return {
    goal: 'Aggregate two upstream sources.',
    trigger: { type: 'manual' },
    required_capabilities: ['aggregate'],
    data_sources: [{ kind: 'fixture', resourceId: 'source-selector' }],
    output_contract: [{ field: 'aggregate', type: 'object' }],
    data_flow_requirements: [{ kind: 'upstream-before-code' }],
    assumptions: [],
    required_user_inputs: [],
    generator_instruction: 'Build the requested aggregate.',
    required_configuration: [{ kind: 'destination', key: 'destination', value: 'fixture-target' }],
  };
}

function node(name, type, parameters = {}) {
  return { name, type, typeVersion: 1, id: `fixture-${name}`, position: [0, 0], parameters };
}

function siblingCandidate(code) {
  return {
    nodes: [
      node('Start', 'test.source'),
      node('Left', 'test.step'),
      node('Right', 'test.step'),
      node('Aggregate', 'n8n-nodes-base.code', { jsCode: code }),
    ],
    connections: {
      Start: { main: [[{ node: 'Left', type: 'main', index: 0 }, { node: 'Right', type: 'main', index: 0 }]] },
      Left: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] },
      Right: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] },
    },
  };
}

function fixedCandidate() {
  return {
    nodes: [
      node('Start', 'test.source'),
      node('Left', 'test.step'),
      node('Right', 'test.step'),
      node('Aggregate', 'n8n-nodes-base.code', {
        jsCode: "const left = $('Left').all(); const right = $('Right').all(); return [{ json: { left: left.length, right: right.length } }];",
      }),
    ],
    connections: {
      Start: { main: [[{ node: 'Left', type: 'main', index: 0 }]] },
      Left: { main: [[{ node: 'Right', type: 'main', index: 0 }]] },
      Right: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] },
    },
  };
}

const CANDIDATE_A = siblingCandidate("const left = $('Left').all(); const right = $('Right').all(); return [{ json: { total: left.length + right.length } }];");
// This changes execution-relevant Code behavior, not UI metadata, while
// deliberately retaining the unsafe sibling any-input fan-in topology.
const CANDIDATE_B = siblingCandidate("const left = $('Left').all(); const right = $('Right').all(); return [{ json: { total: left.length + right.length, mode: 'revised' } }];");
const CANDIDATE_C = siblingCandidate("const missing = $('Missing').all(); return [{ json: { total: missing.length } }];");
const CANDIDATE_D = fixedCandidate();
const CANDIDATE_D_FAILURE = siblingCandidate("const missing = $('Other').all(); return [{ json: { total: missing.length } }];");

function identityStructuralValidator(input) {
  return input.candidateWorkflow;
}

async function runScriptedCreate({ correctnessFirstEnabled, candidates, normalizeWarning = false }) {
  const plan = plannerOutput();
  let contract = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: plan });
  const history = [];
  const attempted = [];
  const contractRevisions = [];
  let controllerCalls = 0;
  let postCalls = 0;
  let readbackCalls = 0;
  let lastControllerReport;
  const controllerFingerprints = [];
  const limit = createCandidateLimit(correctnessFirstEnabled, 3);
  const structuralValidator = normalizeWarning
    ? (input) => ({
      workflow: input.candidateWorkflow,
      warnings: ['A deterministic normalization was applied.'],
      repairs: { connectionPorts: [{
        kind: 'connection_target_port_normalized', sourceNode: 'fixture-source', targetNode: 'fixture-target', connectionType: 'main', fromIndex: 1, toIndex: 0,
        reason: 'runtime schema exposes one compatible target input',
      }] },
    })
    : identityStructuralValidator;
  const evaluateController = async (input) => {
    controllerCalls += 1;
    return evaluateCorrectnessFirstRepair(input);
  };

  for (let attempt = 0; attempt < limit && attempt < candidates.length; attempt += 1) {
    const candidate = candidates[attempt];
    contractRevisions.push(contract.contractRevision);
    const verification = await verifyCandidateWorkflow({
      operation: 'create', userRequest: REQUEST, candidateWorkflow: candidate, acceptanceContract: contract,
    }, { structuralValidator, runtimeSchemas: RUNTIME_SCHEMAS });
    attempted.push({
      candidate: String.fromCharCode(65 + attempt),
      status: verification.status,
      findingRuleIds: verification.findings.map((finding) => finding.ruleId),
    });
    if (verification.status !== 'repair' && verification.status !== 'clarify') {
      postCalls += 1;
      readbackCalls += 1;
      return { attempted, contractRevisions, controllerCalls, postCalls, readbackCalls, lastControllerReport, controllerFingerprints };
    }
    const retry = await decideCreateCandidateRetry({
      correctnessFirstEnabled,
      attempt,
      legacyMaxCandidates: 3,
      evaluateCorrectnessFirstRepair: evaluateController,
      controllerInput: {
        evaluateShadowRepair,
        operation: 'create', userRequest: REQUEST, plannerOutput: plan,
        candidateWorkflow: candidate, verificationResult: verification, existingContract: contract,
        repairState: { history, elapsedMs: attempt * 1000 }, now: attempt * 1000,
      },
    });
    if (retry.controller?.report) {
      lastControllerReport = retry.controller.report;
      controllerFingerprints.push(lastControllerReport.summary.candidateBehaviorFingerprint);
      contract = retry.controller.report.contract;
      history.push({
        behaviorFingerprint: lastControllerReport.summary.candidateBehaviorFingerprint,
        blockingFindingFingerprints: lastControllerReport.summary.blockingFindingFingerprints,
        severity: lastControllerReport.summary.severity,
        contractCoverage: lastControllerReport.summary.contractCoverage,
      });
    }
    if (retry.action !== 'retry') break;
  }
  return { attempted, contractRevisions, controllerCalls, postCalls, readbackCalls, lastControllerReport, controllerFingerprints };
}

test('flag false uses the shared adapter but stops after scripted A, B, and C', async () => {
  const result = await runScriptedCreate({ correctnessFirstEnabled: false, candidates: [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C, CANDIDATE_D] });
  assert.deepEqual(result.attempted.map((item) => item.candidate), ['A', 'B', 'C']);
  assert.ok(result.attempted.every((item) => item.status === 'repair'));
  assert.equal(result.controllerCalls, 0);
  assert.equal(result.postCalls, 0);
  assert.equal(result.readbackCalls, 0);
});

test('scripted A/B/C failures with C first introducing a blocker permit passing D, with one post/readback', async () => {
  const result = await runScriptedCreate({ correctnessFirstEnabled: true, candidates: [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C, CANDIDATE_D] });
  assert.deepEqual(result.attempted.map((item) => item.candidate), ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.attempted.map((item) => item.status), ['repair', 'repair', 'repair', 'pass']);
  assert.ok(result.attempted.slice(0, 2).every((item) => item.findingRuleIds.filter((ruleId) => ruleId === 'dataflow.code_reference.must_execute_before').length === 2));
  assert.equal(result.controllerCalls, 3);
  assert.notEqual(result.controllerFingerprints[0], result.controllerFingerprints[1]);
  assert.equal(result.postCalls, 1);
  assert.equal(result.readbackCalls, 1);
  assert.equal(result.lastControllerReport.repairDecision.reason, 'terminal_repair_for_new_blocking_finding');
  assert.deepEqual(result.contractRevisions, [1, 1, 1, 1]);
});

test('the fourth candidate cannot trigger a fifth generation', async () => {
  const result = await runScriptedCreate({
    correctnessFirstEnabled: true,
    candidates: [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C, CANDIDATE_D_FAILURE, CANDIDATE_D],
  });
  assert.deepEqual(result.attempted.map((item) => item.candidate), ['A', 'B', 'C', 'D']);
  assert.equal(result.controllerCalls, 4);
  assert.equal(result.lastControllerReport.repairDecision.reason, 'repair_budget_exhausted');
  assert.equal(result.postCalls, 0);
  assert.equal(result.readbackCalls, 0);
});

test('same behavior and same blocking findings stop before C', async () => {
  const result = await runScriptedCreate({ correctnessFirstEnabled: true, candidates: [CANDIDATE_A, CANDIDATE_A, CANDIDATE_D] });
  assert.deepEqual(result.attempted.map((item) => item.candidate), ['A', 'B']);
  assert.equal(result.controllerCalls, 2);
  assert.equal(result.postCalls, 0);
  assert.equal(result.lastControllerReport.repairDecision.reason, 'repeated_candidate_state');
});

test('normalization warning does not consume repair budget and safe logs omit fixture workflow details', async () => {
  const result = await runScriptedCreate({ correctnessFirstEnabled: true, candidates: [CANDIDATE_A, CANDIDATE_A], normalizeWarning: true });
  assert.equal(result.lastControllerReport.repairDecision.budgetSummary.llmRepairsUsed, 1);
  assert.ok(result.lastControllerReport.verification.findings.some((finding) => finding.normalized === true));
  const payload = repairControllerLogPayload({ operation: 'create', report: result.lastControllerReport, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(payload), /fixture-|Left|Right|Aggregate|workflow|secret|token/i);
});
