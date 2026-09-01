'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyTwitchStatusExecution } = require('./verifyProvisionedTwitchStatusExecution');

function execution(output) {
  return { id: 'e1', workflowId: 'w1', data: { resultData: { lastNodeExecuted: 'final', runData: { final: [{ data: { main: [[{ json: output }]] } }] } } } };
}

test('verifies the Twitch status output contract without exposing output data', () => {
  const report = verifyTwitchStatusExecution(execution({ channel: 'twitch', isLive: false }), 'w1', 'e1');
  assert.equal(report.status, 'pass');
  assert.equal(JSON.stringify(report).includes('twitch'), false);
});

test('rejects a Twitch output with no boolean status', () => {
  const report = verifyTwitchStatusExecution(execution({ channel: 'twitch', isLive: 'false' }), 'w1', 'e1');
  assert.equal(report.status, 'fail');
});
