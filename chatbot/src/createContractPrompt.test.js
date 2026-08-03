'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAcceptanceContract } = require('./acceptanceContract');
const { buildCorrectnessFirstRepairPrompt } = require('./correctnessFirstRepair');
const {
  buildCreateCandidateMessages,
  buildSemanticReviewerInput,
  contractPromptPayload,
} = require('./createContractPrompt');

function planner() {
  return {
    goal: 'Return a typed summary.',
    trigger: { type: 'manual' },
    data_sources: [{ kind: 'public_source', resourceId: 'source-selector' }],
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
    data_flow_requirements: [{ kind: 'source-before-summary' }],
    assumptions: [], required_user_inputs: [], generator_instruction: 'Build the summary.',
  };
}

function promptPayload(messages) {
  const content = messages.find((message) => message.content.includes('"contractFingerprint"')).content;
  return JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
}

test('every candidate and reviewer receives the same complete immutable contract', () => {
  const contract = normalizeAcceptanceContract({ userRequest: 'Return a typed summary.', plannerResult: planner() });
  const repair = buildCorrectnessFirstRepairPrompt({
    contract,
    findings: [{ ruleId: 'generic.finding', category: 'dataflow', severity: 'repair', repairable: true, normalized: false }],
  });
  const candidates = [
    buildCreateCandidateMessages({ systemPrompt: 'system', userRequest: 'request', acceptanceContract: contract }),
    buildCreateCandidateMessages({ systemPrompt: 'system', userRequest: 'request', acceptanceContract: contract, repairPrompt: repair }),
    buildCreateCandidateMessages({ systemPrompt: 'system', userRequest: 'request', acceptanceContract: contract, repairPrompt: repair }),
    buildCreateCandidateMessages({ systemPrompt: 'system', userRequest: 'request', acceptanceContract: contract, repairPrompt: repair }),
  ];
  const expected = contractPromptPayload(contract);
  assert.deepEqual(candidates.map(promptPayload), [expected, expected, expected, expected]);
  const reviewer = JSON.parse(buildSemanticReviewerInput({ userRequest: 'request', acceptanceContract: contract, workflow: {}, dataflowSummary: {} }));
  assert.deepEqual(reviewer.contract, expected);
  assert.equal(expected.acceptanceContract.outputSchema.itemCount, 1);
  assert.equal(expected.acceptanceContract.outputSchema.fields.length, 2);
});

test('terminal repair keeps the output shape and all typed fields after an earlier finding changes', () => {
  const contract = normalizeAcceptanceContract({ userRequest: 'Return a typed summary.', plannerResult: planner() });
  const terminalRepair = buildCorrectnessFirstRepairPrompt({
    contract,
    findings: [{ ruleId: 'generic.repairable.blocker', category: 'dataflow', severity: 'repair', repairable: true, normalized: false }],
  });
  const payload = promptPayload(buildCreateCandidateMessages({
    systemPrompt: 'system', userRequest: 'request', acceptanceContract: contract, repairPrompt: terminalRepair,
  }));
  assert.deepEqual(payload.acceptanceContract.outputSchema, contract.outputSchema);
  assert.deepEqual(payload.acceptanceContract.executionAssertions, contract.executionAssertions);
  assert.match(terminalRepair, new RegExp(contractPromptPayload(contract).contractFingerprint));
  assert.match(terminalRepair, /"deliveryShape":"single_object_item"/);
});
