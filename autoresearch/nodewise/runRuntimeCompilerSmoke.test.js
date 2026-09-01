'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { safeReport } = require('./runRuntimeCompilerSmoke');

test('keeps the compiler smoke report free of workflow parameters and URLs', () => {
  const report = safeReport({ nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, parameters: { url: 'https://private.example' } }] }, { status: 'pass', findings: [] });
  assert.equal(report.outcome, 'static_pass');
  assert.equal(JSON.stringify(report).includes('private.example'), false);
});
