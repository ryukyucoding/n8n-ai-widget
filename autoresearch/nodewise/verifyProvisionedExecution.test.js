'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyExecution } = require('./verifyProvisionedExecution');

function execution(output) {
  return { id: 'e1', workflowId: 'w1', data: { resultData: { lastNodeExecuted: 'Final', runData: { Final: [{ data: { main: [[{ json: output }]] } }] } } } };
}

test('reports a matching manual execution without exposing its output', () => {
  const report = verifyExecution(execution({ id: 1, title: 'a public post' }), 'w1', 'e1');
  assert.deepEqual({ status: report.status, itemCount: report.itemCount, findingCategories: report.findingCategories }, { status: 'pass', itemCount: 1, findingCategories: {} });
  assert.equal(JSON.stringify(report).includes('public post'), false);
});

test('rejects unexpected final output values', () => {
  const report = verifyExecution(execution({ id: 2, title: 'wrong post' }), 'w1', 'e1');
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.findingCategories, { output_contract: 1 });
});
