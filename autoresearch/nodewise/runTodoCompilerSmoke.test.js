'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { todoSpecification } = require('./runTodoCompilerSmoke');

test('declares a bounded public Todo aggregation contract', () => {
  const spec = todoSpecification();
  assert.equal(spec.steps[1].configuration.url.cardinality, 'items');
  assert.equal(spec.steps[2].configuration.operation, 'count_false_boolean');
  assert.deepEqual(spec.expectedOutput.fields, ['totalTodos', 'incompleteTodos']);
});
