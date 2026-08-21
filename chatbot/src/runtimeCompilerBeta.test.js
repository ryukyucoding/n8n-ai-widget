'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileBetaRequest } = require('./runtimeCompilerBeta');

test('compiles the bounded public Todo request', () => {
  const result = compileBetaRequest('Retrieve public JSONPlaceholder user and todo data, then return a todo summary.');
  assert.equal(result.status, 'supported');
  assert.equal(result.pattern, 'todo_summary');
  assert.equal(result.workflow.nodes.length, 4);
  assert.match(result.workflow.nodes[3].parameters.jsCode, /item\.json/);
});

test('compiles only the fixed public Twitch status request', () => {
  const result = compileBetaRequest('Check Twitch channel twitch live status.');
  assert.equal(result.status, 'supported');
  assert.equal(result.pattern, 'twitch_status');
  assert.equal(result.workflow.nodes.length, 6);
  assert.equal(result.workflow.connections['Step 4: is live'].main.length, 2);
});

test('rejects an unsupported request instead of sending it to a model', () => {
  const result = compileBetaRequest('Generate an invoice in Stripe and email it to my customer.');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'pattern_not_supported');
});
