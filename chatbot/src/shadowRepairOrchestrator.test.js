'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateShadowRepair } = require('./shadowRepairOrchestrator');

const REQUEST = 'Create a report workflow.';

function planner(overrides = {}) {
  return {
    goal: 'Send a report',
    trigger: { type: 'manual' },
    required_capabilities: ['transform-data'],
    data_sources: [{ kind: 'fixture', resourceId: 'report-source' }],
    output_contract: [{ field: 'report', type: 'object' }],
    data_flow_requirements: [],
    assumptions: [],
    required_user_inputs: [],
    generator_instruction: 'Create the workflow.',
    required_configuration: [{ kind: 'destination', key: 'destination', value: 'report@example.test' }],
    ...overrides,
  };
}

function passWorkflow(overrides = {}) {
  return {
    nodes: [{ name: 'Start', type: 'test.source', typeVersion: 1, position: [5, 5], parameters: {} }],
    connections: {},
    ...overrides,
  };
}

function dataflowWorkflow(code) {
  return {
    nodes: [
      { name: 'Start', id: 'random-start-id', type: 'test.source', typeVersion: 1, position: [0, 0], parameters: {} },
      { name: 'Source', id: 'random-source-id', type: 'test.source', typeVersion: 1, position: [0, 100], parameters: {} },
      { name: 'Code', id: 'random-code-id', type: 'n8n-nodes-base.code', typeVersion: 1, position: [300, 0], parameters: { jsCode: code } },
    ],
    connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
  };
}

const RUNTIME_SCHEMAS = {
  'test.source': { versions: { '1': { inputs: [] } } },
  'n8n-nodes-base.code': { versions: { '1': { inputs: ['main'] } } },
};

function evaluate(input = {}) {
  return evaluateShadowRepair({
    operation: 'create',
    userRequest: REQUEST,
    plannerOutput: planner(),
    candidateWorkflow: passWorkflow(),
    verifierOptions: { runtimeSchemas: RUNTIME_SCHEMAS },
    ...input,
  });
}

test('pass candidate produces a pass decision', async () => {
  const report = await evaluate();
  assert.equal(report.verification.status, 'pass');
  assert.equal(report.repairDecision.action, 'pass');
  assert.equal(report.summary.blockingFindingFingerprints.length, 0);
});

test('missing required user information produces clarify', async () => {
  const report = await evaluate({ plannerOutput: planner({ required_user_inputs: [{ question: 'Which report should be sent?' }] }) });
  assert.equal(report.contract.configurationStatus, 'clarification_required');
  assert.equal(report.verification.status, 'clarify');
  assert.equal(report.repairDecision.action, 'clarify');
});

test('schema and dataflow findings produce repair without parsing error strings', async () => {
  const schemaFinding = {
    ruleId: 'node_schema.parameter.invalid', severity: 'repair', evidenceSource: 'runtime_schema', category: 'node_schema',
    location: { kind: 'node_parameter', nodeType: 'test.source', parameter: 'mode' }, message: 'Mode is invalid.', repairable: true, normalized: false,
  };
  const schemaReport = await evaluate({
    verifierOptions: {
      runtimeSchemas: RUNTIME_SCHEMAS,
      structuralValidator: (input) => ({ workflow: input.candidateWorkflow, findings: [schemaFinding] }),
    },
  });
  assert.equal(schemaReport.repairDecision.action, 'repair');
  assert.equal(schemaReport.summary.repairableFindingCount, 1);

  const dataflowReport = await evaluate({ candidateWorkflow: dataflowWorkflow("return [$('Missing').first()];") });
  assert.equal(dataflowReport.verification.findings[0].ruleId, 'dataflow.code_reference.missing_node');
  assert.equal(dataflowReport.repairDecision.action, 'repair');
});

test('same behavior and same blocking findings stops as a cycle', async () => {
  const first = await evaluate({ candidateWorkflow: dataflowWorkflow("return [$('Missing').first()];") });
  const second = await evaluate({
    candidateWorkflow: dataflowWorkflow("return [$('Missing').first()];"),
    repairState: { history: [{
      behaviorFingerprint: first.summary.candidateBehaviorFingerprint,
      blockingFindingFingerprints: first.summary.blockingFindingFingerprints,
    }] },
  });
  assert.equal(second.repairDecision.action, 'stop');
  assert.equal(second.repairDecision.reason, 'repeated_candidate_state');
});

test('same topology with corrected Code or fewer blocking findings remains eligible for repair', async () => {
  const first = await evaluate({ candidateWorkflow: dataflowWorkflow("return [$('Missing').first()];") });
  const second = await evaluate({
    candidateWorkflow: dataflowWorkflow("return [$('Source').first()];"),
    repairState: { history: [{
      behaviorFingerprint: first.summary.candidateBehaviorFingerprint,
      blockingFindingFingerprints: first.summary.blockingFindingFingerprints,
      severity: 'high', contractCoverage: first.summary.contractCoverage,
    }] },
  });
  assert.equal(second.repairDecision.action, 'repair');
  assert.notEqual(second.summary.candidateBehaviorFingerprint, first.summary.candidateBehaviorFingerprint);
  assert.notDeepEqual(second.summary.blockingFindingFingerprints, first.summary.blockingFindingFingerprints);
});

test('deterministic normalization warning does not consume repair budget', async () => {
  const report = await evaluate({
    verifierOptions: {
      runtimeSchemas: RUNTIME_SCHEMAS,
      structuralValidator: (input) => ({
        workflow: input.candidateWorkflow,
        warnings: ['Normalized a known port.'],
        repairs: { connectionPorts: [{
          kind: 'connection_source_port_normalized', sourceNode: 'Start', connectionType: 'main', fromOutputIndex: 1, toOutputIndex: 0,
          reason: 'runtime schema exposes one compatible source output',
        }] },
      }),
    },
  });
  assert.equal(report.repairDecision.action, 'pass');
  assert.equal(report.repairDecision.budgetSummary.llmRepairsUsed, 0);
  assert.equal(report.summary.normalizedWarningCount, 1);
});

test('repair reuses the contract revision and user clarification creates a new one', async () => {
  const first = await evaluate({ plannerOutput: planner({ required_user_inputs: [{ question: 'Which report?' }] }) });
  const repair = await evaluate({ existingContract: first.contract, plannerOutput: planner({ goal: 'Drift must be ignored' }) });
  assert.equal(repair.contract.contractRevision, first.contract.contractRevision);
  assert.deepEqual(repair.contract, first.contract);

  const clarified = await evaluate({
    existingContract: first.contract,
    userClarification: { report: 'daily sales' },
    plannerOutput: planner(),
  });
  assert.equal(clarified.contract.contractRevision, first.contract.contractRevision + 1);
});

test('secret-like data is redacted from reports and the candidate remains unchanged', async () => {
  const workflow = passWorkflow({
    nodes: [{ name: 'Start', id: 'random-id', type: 'test.source', typeVersion: 1, position: [5, 5], parameters: { apiKey: 'sk-live-not-for-report' } }],
  });
  const before = JSON.parse(JSON.stringify(workflow));
  const report = await evaluate({ candidateWorkflow: workflow });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /sk-live-not-for-report/);
  assert.deepEqual(workflow, before);
  assert.doesNotThrow(() => JSON.stringify(report));
});


test('wrapper-item blocker is repairable by the shared repair controller without exposing Code source', async () => {
  const report = await evaluate({
    candidateWorkflow: dataflowWorkflow('const items = $input.all(); return items.filter(item => !item.active);'),
  });
  const finding = report.verification.findings.find((item) => item.ruleId === 'dataflow.code_item_wrapper.use_json_payload');
  assert.equal(report.verification.status, 'repair');
  assert.equal(report.repairDecision.action, 'repair');
  assert.equal(finding.repairable, true);
  assert.ok(report.summary.repairableFindingCount >= 1);
  assert.doesNotMatch(JSON.stringify(finding), /active|filter/);
});
