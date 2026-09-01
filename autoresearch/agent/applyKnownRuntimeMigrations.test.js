'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyKnownRuntimeMigrations } = require('./applyKnownRuntimeMigrations');

const gemini = '@n8n/n8n-nodes-langchain.googleGemini';
const shopify = 'n8n-nodes-base.shopify';
const findings = (nodeIndex, nodeType, names) => names.map((parameterName) => ({ category: 'parameter_schema', repairContext: { nodeIndex, nodeType, parameterName } }));

test('migrates the confirmed Gemini and Shopify legacy shapes without exposing values', () => {
  const workflow = { nodes: [
    { type: gemini, parameters: { modelId: 'private', options: {}, messages: {}, jsonOutput: true } },
    { type: shopify, parameters: { title: 'private', bodyHtml: 'private', vendor: 'private', productType: 'private' } },
  ] };
  const result = applyKnownRuntimeMigrations(workflow, [
    ...findings(0, gemini, ['modelId', 'options', 'messages', 'jsonOutput']),
    ...findings(1, shopify, ['title', 'bodyHtml', 'vendor', 'productType']),
  ]);
  assert.equal(result.blocked.length, 0);
  assert.deepEqual(result.actions.map((action) => action.kind), ['select_gemini_text_message', 'migrate_shopify_product_create_fields']);
  assert.equal(workflow.nodes[0].parameters.resource, 'text');
  assert.equal(workflow.nodes[0].parameters.operation, 'message');
  assert.equal(workflow.nodes[1].parameters.resource, 'product');
  assert.equal(workflow.nodes[1].parameters.operation, 'create');
  assert.equal(Object.hasOwn(workflow.nodes[1].parameters, 'bodyHtml'), false);
  assert.deepEqual(Object.keys(workflow.nodes[1].parameters.additionalFields).sort(), ['body_html', 'product_type', 'vendor']);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('refuses to overwrite existing Shopify additional fields', () => {
  const workflow = { nodes: [{ type: shopify, parameters: { title: 'private', bodyHtml: 'private', vendor: 'private', productType: 'private', additionalFields: { vendor: 'existing' } } }] };
  const result = applyKnownRuntimeMigrations(workflow, findings(0, shopify, ['title', 'bodyHtml', 'vendor', 'productType']));
  assert.equal(result.actions.length, 0);
  assert.deepEqual(result.blocked, [{ kind: 'shopify_additional_fields_conflict', nodeIndex: 0, nodeType: shopify }]);
});
