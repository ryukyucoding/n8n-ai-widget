'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PREFIX, createFailure, safeReport } = require('./provisionRuntimeCompilerWorkflow');

test('reports only exact workflow identity and safe compiler evidence', () => {
  const report = safeReport({
    workflow: { nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, parameters: { url: 'https://private.example' } }] },
    verification: { status: 'pass' }, created: { id: '123', name: `${PREFIX}x` }, readback: { active: false },
  });
  assert.equal(report.workflowId, '123');
  assert.equal(report.cleanup.exactWorkflowId, '123');
  assert.equal(JSON.stringify(report).includes('private.example'), false);
});

test('classifies n8n create validation failures without exposing the response body', async () => {
  const error = await createFailure({ status: 400, text: async () => 'node id must be a UUID; secret=not-for-reporting' });
  assert.equal(error.message, 'workflow_create_failed_400:node_schema_rejected');
  assert.equal(error.message.includes('secret'), false);
});
