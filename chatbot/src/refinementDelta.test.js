'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRefinementDelta } = require('./refinementDelta');

function specification() {
  return {
    schemaVersion: '1.0',
    kind: 'nodewise_step_specification',
    goal: 'Fetch user 1 todos and report counts.',
    expectedOutput: { deliveryShape: 'one_object', fields: ['total', 'incomplete'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', configuration: {} },
      { id: 'todos', capability: 'http_request', configuration: { url: { cardinality: 'items' } } },
      { id: 'sorted', capability: 'data_transform', configuration: {
        operation: 'sort_items', input: { cardinality: 'items' }, field: 'id', order: 'ascending',
      } },
      { id: 'limited', capability: 'data_transform', configuration: {
        operation: 'limit_items', input: { cardinality: 'items' }, limit: 5, keep: 'firstItems',
      } },
    ],
  };
}

test('Chinese sort refinement changes only the existing sort order', () => {
  const previous = specification();
  const result = applyRefinementDelta(previous, '改成降序');
  assert.equal(result.matched, true);
  assert.equal(result.operation, 'sort_items');
  assert.equal(result.specification.goal, previous.goal);
  assert.equal(result.specification.steps[2].configuration.order, 'descending');
  assert.equal(previous.steps[2].configuration.order, 'ascending');
  assert.equal(result.specification.steps[3].configuration.limit, 5);
});

test('English limit refinement changes only the existing limit', () => {
  const previous = specification();
  const result = applyRefinementDelta(previous, 'Change the limit to 10.');
  assert.equal(result.matched, true);
  assert.equal(result.operation, 'limit_items');
  assert.equal(result.specification.goal, previous.goal);
  assert.equal(result.specification.steps[3].configuration.limit, 10);
  assert.equal(result.specification.steps[2].configuration.order, 'ascending');
});

test('recognized refinement without a target never invents a step', () => {
  const previous = specification();
  previous.steps = previous.steps.filter((step) => step.id !== 'sorted');
  const result = applyRefinementDelta(previous, 'sort descending');
  assert.equal(result.matched, false);
  assert.equal(result.recognized, true);
  assert.equal(result.reason, 'target_missing');
  assert.deepEqual(result.specification, undefined);
});

test('unsupported or out-of-bounds deltas are not silently applied', () => {
  const previous = specification();
  const unknown = applyRefinementDelta(previous, 'change the limit to 1001');
  assert.equal(unknown.matched, false);
  assert.equal(unknown.reason, 'limit_out_of_bounds');
  const fresh = applyRefinementDelta(null, 'Change the limit to 10');
  assert.equal(fresh.recognized, false);
});
