'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { callToolPlanner, planFromArguments } = require('./runToolPlanner');
function response(message) { return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } }); }
const runtimeContext = { candidateNodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }], explicitlyNamedNodeRequirements: { required: [], forbidden: [] } };

test('builds an accepted plan through catalog then constrained submission', async () => {
  const calls = [
    { role: 'assistant', tool_calls: [{ id: 'catalog', function: { name: 'get_runtime_catalog', arguments: '{}' } }] },
    { role: 'assistant', tool_calls: [{ id: 'plan', function: { name: 'submit_plan', arguments: JSON.stringify({ goal: 'Read API', selected_nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }], generator_instruction: 'Read it.', required_user_inputs: [], required_configuration: [] }) } }] },
  ];
  const result = await callToolPlanner({ userRequest: 'Read API', runtimeContext, model: 'test', env: { OLLAMA_BASE_URL: 'http://example.test' }, fetchImpl: async () => response(calls.shift()) });
  assert.equal(result.plan.goal, 'Read API');
  assert.deepEqual(result.toolCalls, ['get_runtime_catalog', 'submit_plan']);
});

test('converts fixed tool fields into a full planner envelope', () => {
  const plan = planFromArguments({ goal: 'x', selected_nodes: [], generator_instruction: 'y', required_user_inputs: ['account'], required_configuration: ['credential'] });
  assert.deepEqual(plan.required_user_inputs, [{ label: 'account' }]);
  assert.equal(plan.output_contract.required, false);
});
