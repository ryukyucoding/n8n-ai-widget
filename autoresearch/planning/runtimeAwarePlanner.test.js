'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPlanFirstContract, buildRuntimeAwarePlannerMessages, normalizePlan, parsePlanJson } = require('./runtimeAwarePlanner');

const context = {
  candidateNodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, parameters: [{ name: 'url' }] }],
  instruction: 'Use only supplied nodes.',
};

function plan(overrides = {}) {
  return JSON.stringify({
    goal: 'Read a public API',
    trigger: 'manual',
    selected_nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }],
    output_contract: { required: true, delivery_shape: 'single_object_item', item_count: 1, fields: [{ path: 'name', required: true, expected_type: 'string' }] },
    data_sources: [], data_flow_requirements: [], assumptions: [], required_user_inputs: [], required_configuration: [], generator_instruction: 'Use the selected HTTP Request node.',
    ...overrides,
  });
}

test('builds a contract only when selected nodes match the runtime catalog', () => {
  const result = buildPlanFirstContract({ userRequest: 'Read an API', rawPlan: plan(), runtimeContext: context });
  assert.equal(result.plan.selected_nodes[0].typeVersion, 4.4);
  assert.equal(result.acceptanceContract.configurationStatus, 'complete');
});

test('rejects invented runtime nodes and keeps required user input explicit', () => {
  assert.throws(() => normalizePlan(plan({ selected_nodes: [{ type: 'made.up', typeVersion: 1 }] }), context), /outside/);
  const messages = buildRuntimeAwarePlannerMessages({ userRequest: 'Read an API', runtimeContext: context });
  assert.equal(messages.length, 3);
  assert.match(messages[0].content, /credential values/);
  assert.equal(parsePlanJson('Plan: {"goal":"x"}').goal, 'x');
});
