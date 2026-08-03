'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAcceptanceContract } = require('./acceptanceContract');

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
