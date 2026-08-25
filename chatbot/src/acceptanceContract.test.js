'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAcceptanceContract } = require('./acceptanceContract');
const { verifyExecutionOutput } = require('./executionAssertion');
const { createContractReady } = require('./createContractPrompt');

const REQUEST = 'Create a daily sales report workflow.';

function completePlanner(overrides = {}) {
  return {
    goal: 'Deliver a sales report',
    trigger: { type: 'schedule', cadence: 'daily' },
    required_capabilities: ['fetch-sales', 'send-email'],
    data_sources: [{ kind: 'postgres', resourceId: 'sales-db' }],
    output_contract: [{ field: 'totalSales', type: 'number' }],
    data_flow_requirements: [{ from: 'sales-db', to: 'email' }],
    assumptions: ['Sales database contains the current day.'],
    required_user_inputs: [],
    generator_instruction: 'Build a daily report.',
    required_configuration: [
      { kind: 'destination', key: 'emailDestination', value: 'ops@example.test' },
      { kind: 'credential_reference', key: 'salesCredential', credentialReference: 'credential:postgres:sales-readonly' },
    ],
    ...overrides,
  };
}

test('normalizes the same request and planner result into a stable contract', () => {
  const first = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: completePlanner(), deliveryMode: 'candidate-only' });
  const second = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: completePlanner(), deliveryMode: 'candidate-only' });
  assert.deepEqual(first, second);
  assert.equal(first.contractVersion, '1.0');
  assert.equal(first.contractRevision, 1);
  assert.equal(first.configurationStatus, 'complete');
  assert.deepEqual(first.requiredCapabilities, ['fetch-sales', 'send-email']);
});

test('n8n-draft retains unresolved configuration without guessing it', () => {
  const contract = normalizeAcceptanceContract({
    userRequest: REQUEST,
    deliveryMode: 'n8n-draft',
    plannerResult: completePlanner({ required_configuration: [{ kind: 'destination', key: 'emailDestination' }] }),
  });
  assert.equal(contract.deliveryMode, 'n8n-draft');
  assert.equal(contract.configurationStatus, 'clarification_required');
  assert.equal(contract.requiredConfiguration[0].value, null);
});

test('ready-to-run reports clarification required for destination, credential reference, or user input', () => {
  const missingDestination = normalizeAcceptanceContract({
    userRequest: REQUEST, deliveryMode: 'ready-to-run',
    plannerResult: completePlanner({ required_configuration: [{ kind: 'destination', key: 'emailDestination' }] }),
  });
  assert.equal(missingDestination.configurationStatus, 'clarification_required');

  const missingCredential = normalizeAcceptanceContract({
    userRequest: REQUEST, deliveryMode: 'ready-to-run',
    plannerResult: completePlanner({ required_configuration: [{ kind: 'credential_reference', key: 'salesCredential' }] }),
  });
  assert.equal(missingCredential.configurationStatus, 'clarification_required');

  const missingUserInput = normalizeAcceptanceContract({
    userRequest: REQUEST, deliveryMode: 'ready-to-run',
    plannerResult: completePlanner({ required_user_inputs: [{ question: 'Which mailbox should receive the report?' }] }),
  });
  assert.equal(missingUserInput.configurationStatus, 'clarification_required');
});

test('ready-to-run is complete only with explicit configuration and no required user input', () => {
  const contract = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: completePlanner(), deliveryMode: 'ready-to-run' });
  assert.equal(contract.configurationStatus, 'complete');
  assert.equal(contract.requiredConfiguration[1].credentialReference, 'credential:postgres:sales-readonly');
});

test('rejects secret-like credential values and does not place them in a contract', () => {
  assert.throws(() => normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: completePlanner({ required_configuration: [{ key: 'sales', apiKey: 'sk-live-secret' }] }),
  }), /credential value is not allowed/);
  assert.throws(() => normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: completePlanner({ data_sources: [{ kind: 'api', authorization: 'Bearer secret-value' }] }),
  }), /secret-like credential value is not allowed/);
});

test('only user clarification creates a new contract revision', () => {
  const initial = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: completePlanner() });
  const repairReuse = normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: completePlanner({ output_contract: [{ field: 'different', type: 'string' }] }),
    existingContract: initial,
  });
  assert.deepEqual(repairReuse, initial);

  const revised = normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: completePlanner({ required_user_inputs: [] }),
    existingContract: initial,
    userClarification: { emailDestination: 'ops@example.test' },
  });
  assert.equal(revised.contractRevision, 2);
  assert.equal(revised.requestHash, initial.requestHash);
});

test('the contract does not change when a later candidate repair is evaluated', () => {
  const contract = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: completePlanner() });
  const frozenForRepair = normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: completePlanner({ assumptions: ['A later candidate changed this.'] }),
    existingContract: contract,
  });
  assert.deepEqual(frozenForRepair, contract);
  assert.notStrictEqual(frozenForRepair, contract);
});

test('retains only explicitly declared execution assertions without inferring them', () => {
  const declared = normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: completePlanner({
      execution_assertions: [{ path: 'summary.incompleteCount', expectedType: 'number', equals: 9 }],
    }),
  });
  assert.deepEqual(declared.executionAssertions, [
    { path: 'summary.incompleteCount', expectedType: 'number', equals: 9 },
  ]);

  const absent = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: completePlanner() });
  assert.deepEqual(absent.executionAssertions, []);
});

function typedOutputPlanner(overrides = {}) {
  return completePlanner({
    output_contract_required: true,
    output_contract: {
      required: true,
      delivery_shape: 'single_object_item',
      item_count: 1,
      fields: [
        { path: 'summary', required: true, expected_type: 'object' },
        { path: 'count', required: true, expected_type: 'number' },
      ],
    },
    ...overrides,
  });
}

test('normalizes a typed single-object output contract into immutable execution assertions', () => {
  const contract = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: typedOutputPlanner() });
  assert.equal(contract.configurationStatus, 'complete');
  assert.equal(contract.outputSchema.deliveryShape, 'single_object_item');
  assert.equal(contract.outputSchema.itemCount, 1);
  assert.deepEqual(contract.executionAssertions, [
    { kind: 'item_count', equals: 1 },
    { path: 'summary', required: true, expectedType: 'object' },
    { path: 'count', required: true, expectedType: 'number' },
  ]);
});

test('typed contract rejects a stringified final object through the same assertions', () => {
  const contract = normalizeAcceptanceContract({ userRequest: REQUEST, plannerResult: typedOutputPlanner() });
  const result = verifyExecutionOutput({
    executionOutput: [{ json: { summary: '{"count":1}', count: 1 } }],
    acceptanceContract: contract,
    executionSafety: true,
  });
  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((finding) => finding.rule === 'execution_assertion.type'));
});

test('rejects mixed canonical field aliases within one typed contract', () => {
  assert.throws(() => normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: typedOutputPlanner({
      output_contract: {
        required: true, delivery_shape: 'single_object_item', item_count: 1,
        fields: [
          { path: 'resultCount', required: true, expected_type: 'number' },
          { path: 'result_count', required: true, expected_type: 'number' },
        ],
      },
    }),
  }), /must not mix aliases/);
});

test('required typed output contract without a complete schema stays on the clarify path', () => {
  const contract = normalizeAcceptanceContract({
    userRequest: REQUEST,
    plannerResult: completePlanner({ output_contract_required: true, output_contract: [] }),
  });
  assert.equal(contract.configurationStatus, 'clarification_required');
  assert.equal(contract.outputSchema.status, 'clarification_required');
  assert.equal(createContractReady(contract), false);
});
