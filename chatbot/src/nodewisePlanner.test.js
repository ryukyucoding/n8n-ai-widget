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
