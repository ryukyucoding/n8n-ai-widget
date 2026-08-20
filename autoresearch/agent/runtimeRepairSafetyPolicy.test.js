'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canAutomaticallyRemoveParameter, classifyAuthoritativeFindings, dispositionForParameter } = require('./runtimeRepairSafetyPolicy');

test('does not allow arbitrary invalid parameters to be silently deleted', () => {
  assert.equal(canAutomaticallyRemoveParameter(), false);
  assert.equal(dispositionForParameter('credentialId'), 'requires_user_setup');
  assert.equal(dispositionForParameter('message'), 'semantic_regeneration_required');
  assert.equal(dispositionForParameter('legacyFlag'), 'manual_review_required');
});

test('classifies known migrations without exposing parameter values', () => {
  const result = classifyAuthoritativeFindings({
    workflow: { nodes: [{ type: '@n8n/n8n-nodes-langchain.googleGemini', parameters: { modelId: 'private', options: {}, messages: {}, jsonOutput: true } }] },
    findings: [
      { category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: '@n8n/n8n-nodes-langchain.googleGemini', parameterName: 'modelId' } },
      { category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: '@n8n/n8n-nodes-langchain.googleGemini', parameterName: 'options' } },
      { category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: '@n8n/n8n-nodes-langchain.googleGemini', parameterName: 'messages' } },
      { category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: '@n8n/n8n-nodes-langchain.googleGemini', parameterName: 'jsonOutput' } },
      { category: 'node_type', repairContext: { requiredNodeType: 'n8n-nodes-base.set' } },
    ],
  });
  assert.deepEqual(result.classifications.map((item) => item.disposition), ['known_runtime_migration', 'known_runtime_migration', 'known_runtime_migration', 'known_runtime_migration', 'semantic_regeneration_required']);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
