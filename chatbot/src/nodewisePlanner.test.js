'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertUserRequest,
  parsePlannerResponse,
  requestNodewisePlannerResult,
} = require('./nodewisePlanner');

const clarification = JSON.stringify({
  schemaVersion: '1.0',
  kind: 'nodewise_planner_result',
  outcome: 'clarification_required',
  goal: 'Fetch public data.',
  requiredUserInputs: ['Which public HTTPS GET URL should be used?'],
  capabilityGaps: [],
});

test('requires a non-empty user request and strict JSON from the planner', () => {
  assert.throws(() => assertUserRequest('   '), /message is required/);
  assert.throws(() => parsePlannerResponse('not json'), /invalid JSON/);
});

test('uses the canonical prompt and validates the returned envelope', async () => {
  const calls = [];
  const client = { chat: { completions: { create: async (request, options) => {
    calls.push({ request, options });
    return { choices: [{ message: { content: clarification } }] };
  } } } };
  const result = await requestNodewisePlannerResult({
    client, model: 'qwen3.8:27b', userRequest: 'Fetch something.', signal: 'test-signal',
  });
  assert.equal(result.outcome, 'clarification_required');
  assert.equal(calls[0].request.model, 'qwen3.8:27b');
  assert.equal(calls[0].request.temperature, 0);
  assert.match(calls[0].request.messages[0].content, /final step must produce exactly expectedOutput\.fields/);
  assert.equal(calls[0].options.signal, 'test-signal');
});

test('passes only a sanitized previous specification as refinement context', async () => {
  const calls = [];
  const client = { chat: { completions: { create: async (request) => {
    calls.push(request);
    return { choices: [{ message: { content: clarification } }] };
  } } } };
  await requestNodewisePlannerResult({
    client,
    model: 'qwen3.8:27b',
    userRequest: 'Change the limit to 10.',
    previousSpecification: {
      schemaVersion: '1.0',
      kind: 'nodewise_step_specification',
      goal: 'Keep this goal',
      steps: [{
        id: 'limited',
        capability: 'data_transform',
        configuration: {
          operation: 'limit_items',
          input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' },
          limit: 5,
          secret: 'must-drop',
        },
      }],
    },
  });
  const content = calls[0].messages[1].content;
  assert.match(content, /Change the limit to 10/);
  assert.match(content, /Keep this goal/);
  assert.doesNotMatch(content, /must-drop|secret/);
});
