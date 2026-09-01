'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyTodoExecution } = require('./verifyProvisionedTodoExecution');

function execution(output) {
  return { id: 'e1', workflowId: 'w1', data: { resultData: { lastNodeExecuted: 'Count', runData: { Count: [{ data: { main: [[{ json: output }]] } }] } } } };
}

test('verifies the Todo count contract without exposing output values', () => {
  const report = verifyTodoExecution(execution({ totalTodos: 20, incompleteTodos: 9 }), 'w1', 'e1');
  assert.deepEqual({ status: report.status, itemCount: report.itemCount, findingCategories: report.findingCategories }, { status: 'pass', itemCount: 1, findingCategories: {} });
  assert.equal(JSON.stringify(report).includes('totalTodos'), false);
});

test('rejects an incorrect Todo count', () => {
  const report = verifyTodoExecution(execution({ totalTodos: 20, incompleteTodos: 20 }), 'w1', 'e1');
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.findingCategories, { output_contract: 1 });
});
