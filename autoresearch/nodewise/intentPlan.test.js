'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseAndValidateIntentPlan } = require('./intentPlan');

function fixture() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_workflow_intent', goal: 'Read records and return a count.',
    steps: [
      { id: 'start', capability: 'manual_trigger', purpose: 'Start the workflow.', inputs: [], outputs: ['start.signal'], requiredUserSetup: [] },
      { id: 'read', capability: 'http_request', purpose: 'Read public records.', inputs: ['start.signal'], outputs: ['read.items'], requiredUserSetup: [] },
      { id: 'summarize', capability: 'data_transform', purpose: 'Count records.', inputs: ['read.items'], outputs: ['summarize.count'], requiredUserSetup: [] },
    ],
    expectedOutput: { deliveryShape: 'one_object', fields: ['count'] }, requiredUserSetup: [],
  };
}

test('accepts an ordered nodewise intent plan', () => {
  const plan = parseAndValidateIntentPlan(JSON.stringify(fixture()));
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.expectedOutput.deliveryShape, 'one_object');
});

test('rejects a future data-flow reference', () => {
  const plan = fixture();
  plan.steps[1].inputs = ['summarize.count'];
  assert.throws(() => parseAndValidateIntentPlan(JSON.stringify(plan)), /earlier step/);
});

test('rejects raw workflow JSON in place of intent', () => {
  assert.throws(() => parseAndValidateIntentPlan(JSON.stringify({ nodes: [], connections: {} })), /schemaVersion/);
});
