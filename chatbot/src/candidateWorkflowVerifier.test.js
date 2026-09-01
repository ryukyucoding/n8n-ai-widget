'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyCandidateWorkflow } = require('./candidateWorkflowVerifier');

function validWorkflow() {
  return {
    name: 'Verifier test',
    nodes: [
      { name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items;' } },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
    },
  };
}

function structuralValidator(input) {
  return input.candidateWorkflow;
}

function assertFindingShape(finding) {
  assert.deepEqual(Object.keys(finding).sort(), [
    'category', 'evidenceSource', 'location', 'message', 'normalized', 'repairable', 'ruleId', 'severity',
  ]);
  assert.match(finding.ruleId, /\S/);
  assert.ok(['fatal', 'clarify', 'repair', 'warning'].includes(finding.severity));
  assert.ok(['runtime_schema', 'runtime_contract', 'deterministic_normalizer', 'semantic_review', 'n8n_api'].includes(finding.evidenceSource));
  assert.ok(['json', 'node_schema', 'connection', 'dataflow', 'semantic', 'configuration'].includes(finding.category));
  assert.equal(typeof finding.location, 'object');
  assert.equal(typeof finding.message, 'string');
  assert.equal(typeof finding.repairable, 'boolean');
  assert.equal(typeof finding.normalized, 'boolean');
}

test('validates a producer-neutral candidate and returns structured pass', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'modify',
    userRequest: 'Add a Code node',
    candidateWorkflow: validWorkflow(),
  }, { structuralValidator });

  assert.equal(result.status, 'pass');
  assert.equal(result.workflow.name, 'Verifier test');
  assert.equal(result.verification.operation, 'modify');
  assert.equal(result.verification.dataflow.status, 'pass');
  assert.deepEqual(result.findings, []);
});

test('returns repair for objective Code dataflow failures before semantic review', async () => {
  const candidate = validWorkflow();
  candidate.nodes[1].parameters.jsCode = "return [$('Missing').first()];";
  let reviewerCalled = false;
  const result = await verifyCandidateWorkflow({
    operation: 'insert', userRequest: 'Use the source', candidateWorkflow: candidate,
  }, {
    structuralValidator,
    semanticReview: async () => { reviewerCalled = true; return { verdict: 'pass', issues: [], repairInstruction: '' }; },
  });

  assert.equal(result.status, 'repair');
  assert.match(result.errors[0], /Missing/);
  assert.equal(reviewerCalled, false);
  assert.equal(result.findings.length, 1);
  assertFindingShape(result.findings[0]);
  assert.equal(result.findings[0].ruleId, 'dataflow.code_reference.missing_node');
  assert.equal(result.findings[0].evidenceSource, 'runtime_contract');
  assert.equal(result.findings[0].category, 'dataflow');
});

test('downgrades reviewer claims that conflict with verified dataflow to warnings', async () => {
  const candidate = validWorkflow();
  candidate.nodes.splice(1, 0, { name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters: {} });
  candidate.nodes[2].parameters.jsCode = "return [$('HTTP').first()];";
  candidate.connections = {
    'Manual Trigger': { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] },
    HTTP: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
  };
  const result = await verifyCandidateWorkflow({
    operation: 'create', userRequest: 'Fetch and return data', candidateWorkflow: candidate,
  }, {
    structuralValidator,
    semanticReview: async () => ({
      verdict: 'revise', repairInstruction: 'Add a direct data connection.', issues: [{
        message: 'HTTP does not reach Code.',
        evidence: { kind: 'code_dataflow', code_node: 'Code', referenced_node: 'HTTP' },
      }],
    }),
  });

  assert.equal(result.status, 'warning');
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
});

test('returns precise clarification without guessing required inputs', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'delete',
    userRequest: 'Delete a node',
    candidateWorkflow: validWorkflow(),
    acceptanceContract: { requiredUserInputs: [{ question: 'Which node should be deleted?' }] },
  }, { structuralValidator });

  assert.equal(result.status, 'clarify');
  assert.deepEqual(result.errors, ['required user input: Which node should be deleted?']);
});

test('returns clarification before validation when the contract requires a missing typed output schema', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'create', userRequest: 'Return a typed output', candidateWorkflow: validWorkflow(),
    acceptanceContract: { outputSchema: { status: 'clarification_required' } },
  }, { structuralValidator });
  assert.equal(result.status, 'clarify');
  assert.equal(result.findings[0].ruleId, 'acceptance_contract.output_schema.required');
});

test('normalizes one source output port and reports sibling any-input Code findings together', async () => {
  const candidate = {
    name: 'Combined verifier feedback',
    nodes: [
      { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'left', name: 'Left', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
      { id: 'right', name: 'Right', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 120], parameters: {} },
      { id: 'compute', name: 'Compute', type: 'n8n-nodes-base.code', typeVersion: 2, position: [400, 0], parameters: { jsCode: "const left = $('Left').all(); const right = $('Right').all(); return items;" } },
    ],
    connections: {
      Start: { main: [[], [
        { node: 'Left', type: 'main', index: 0 },
        { node: 'Right', type: 'main', index: 0 },
      ]] },
      Left: { main: [[{ node: 'Compute', type: 'main', index: 0 }]] },
      Right: { main: [[{ node: 'Compute', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  };

  const result = await verifyCandidateWorkflow({
    operation: 'create', userRequest: 'Create a workflow with two independent branches and a calculation.', candidateWorkflow: candidate,
  }, {
    // This is a verifier unit test. Supply the result the structural
    // normalizer is responsible for instead of depending on Python/n8n.
    structuralValidator: () => ({
      workflow: {
        ...candidate,
        connections: {
          ...candidate.connections,
          Start: { main: [candidate.connections.Start.main[1]] },
        },
      },
      warnings: ['normalized source output port from 1 to 0'],
      repairs: {
        connectionPorts: [{
          kind: 'connection_source_port_normalized',
          sourceNode: 'Start',
          targetNode: 'Left',
          connectionType: 'main',
          fromOutputIndex: 1,
          toOutputIndex: 0,
          reason: 'normalized source output port from 1 to 0',
        }],
      },
    }),
  });

  assert.equal(result.status, 'repair');
  assert.equal(result.workflow.connections.Start.main.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('source output port from 1 to 0')));
  assert.ok(result.verification.structural.repairs.connectionPorts.some((repair) => repair.kind === 'connection_source_port_normalized'));
  assert.equal(result.errors.filter((error) => error.includes('reachable but not guaranteed to execute')).length, 2);
  const normalizedPort = result.findings.find((finding) => finding.ruleId === 'connection.port.source_output.normalized');
  assertFindingShape(normalizedPort);
  assert.equal(normalizedPort.severity, 'warning');
  assert.equal(normalizedPort.evidenceSource, 'deterministic_normalizer');
  assert.equal(normalizedPort.category, 'connection');
  assert.equal(normalizedPort.normalized, true);
  const mustExecuteFindings = result.findings.filter((finding) => finding.ruleId === 'dataflow.code_reference.must_execute_before');
  assert.equal(mustExecuteFindings.length, 2);
  assert.ok(mustExecuteFindings.every((finding) => finding.evidenceSource === 'runtime_contract' && finding.category === 'dataflow'));
});

test('preserves structural error text while accepting source-provided node schema findings', async () => {
  const structuralValidatorWithFinding = () => {
    const error = new Error('workflow parameter validation failed: node \'Code\': parameters.jsCode must be a string');
    error.findings = [{
      ruleId: 'node_schema.parameter.invalid_type',
      severity: 'repair',
      evidenceSource: 'runtime_schema',
      category: 'node_schema',
      location: { kind: 'node_parameter', nodeType: 'n8n-nodes-base.code', parameter: 'jsCode' },
      message: 'Code parameter has an invalid type.',
      repairable: true,
      normalized: false,
    }];
    throw error;
  };
  const result = await verifyCandidateWorkflow({
    operation: 'create', userRequest: 'Create a Code workflow', candidateWorkflow: validWorkflow(),
  }, { structuralValidator: structuralValidatorWithFinding });

  assert.equal(result.status, 'repair');
  assert.deepEqual(result.errors, ["workflow parameter validation failed: node 'Code': parameters.jsCode must be a string"]);
  assert.equal(result.findings.length, 1);
  assertFindingShape(result.findings[0]);
  assert.equal(result.findings[0].ruleId, 'node_schema.parameter.invalid_type');
  assert.equal(result.findings[0].category, 'node_schema');
});


test('returns a repairable structured blocker for direct $input.all() payload reads before semantic review', async () => {
  const candidate = validWorkflow();
  candidate.nodes[1].parameters.jsCode = 'const items = $input.all(); return items.filter(item => !item.active);';
  let reviewerCalled = false;
  const result = await verifyCandidateWorkflow({
    operation: 'create', userRequest: 'Transform input items', candidateWorkflow: candidate,
  }, {
    structuralValidator,
    semanticReview: async () => { reviewerCalled = true; return { verdict: 'pass', issues: [], repairInstruction: '' }; },
  });

  assert.equal(result.status, 'repair');
  assert.equal(reviewerCalled, false);
  const finding = result.findings.find((item) => item.ruleId === 'dataflow.code_item_wrapper.use_json_payload');
  assertFindingShape(finding);
  assert.equal(finding.severity, 'repair');
  assert.equal(finding.evidenceSource, 'runtime_contract');
  assert.equal(finding.category, 'dataflow');
  assert.equal(finding.repairable, true);
  assert.deepEqual(finding.location, { kind: 'code_item_wrapper_access', codeNodeName: 'Code' });
  assert.doesNotMatch(JSON.stringify(finding), /active|\\$input|filter/);
});
