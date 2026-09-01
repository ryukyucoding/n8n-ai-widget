'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectIntentTrial } = require('./collectIntentTrial');

const validReply = JSON.stringify({
  schemaVersion: '1.0', kind: 'nodewise_workflow_intent', goal: 'Return a result.',
  steps: [{ id: 'start', capability: 'manual_trigger', purpose: 'Start.', inputs: [], outputs: ['start.signal'], requiredUserSetup: [] }],
  expectedOutput: { deliveryShape: 'one_object', fields: ['result'] }, requiredUserSetup: [],
});

test('reports valid plans without retaining reply content', () => {
  const report = collectIntentTrial({ tasks: [{ id: 'task_a', taskType: 'nodewise_intent_plan', state: 'completed', messages: [{ senderAgentId: 'debugger', state: 'completed', text: validReply }] }] });
  assert.equal(report.aggregate.valid_plan, 1);
  assert.equal(JSON.stringify(report).includes('Return a result'), false);
});

test('classifies invalid replies', () => {
  const report = collectIntentTrial({ tasks: [{ id: 'task_b', taskType: 'nodewise_intent_plan', state: 'completed', messages: [{ senderAgentId: 'debugger', state: 'completed', text: '```json\n{}\n```' }] }] });
  assert.equal(report.records[0].outcome, 'contract_rejected');
  assert.equal(report.records[0].errorCategory, 'not_json_object');
});
