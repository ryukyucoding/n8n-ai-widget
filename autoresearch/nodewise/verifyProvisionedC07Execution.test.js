'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyC07Execution } = require('./verifyProvisionedC07Execution');

function execution(output) {
  return { id: 'e1', workflowId: 'w1', data: { resultData: { lastNodeExecuted: 'Summary', runData: { Summary: [{ data: { main: [[{ json: output }]] } }] } } } };
}

test('verifies the C07 output contract without exposing the output', () => {
  const report = verifyC07Execution(execution({ name: 'Leanne Graham', email: 'Sincere@april.biz', totalTodos: 20, incompleteTodos: 9 }), 'w1', 'e1');
  assert.deepEqual({ status: report.status, itemCount: report.itemCount, findingCategories: report.findingCategories }, { status: 'pass', itemCount: 1, findingCategories: {} });
  assert.equal(JSON.stringify(report).includes('Leanne'), false);
});

test('rejects an incorrect C07 summary', () => {
  const report = verifyC07Execution(execution({ name: 'Leanne Graham', email: 'Sincere@april.biz', totalTodos: 20, incompleteTodos: 20 }), 'w1', 'e1');
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.findingCategories, { output_contract: 1 });
});
