'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileStepSpecification } = require('./runtimeCompiler');

function schemas() {
  const descriptor = { properties: [], inputs: ['main'], outputs: ['main'] };
  return {
    'n8n-nodes-base.manualTrigger': { versions: { '1': descriptor } },
    'n8n-nodes-base.httpRequest': { versions: { '4.4': descriptor } },
    'n8n-nodes-base.set': { versions: { '3.4': descriptor } },
  };
}

function specification() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Read a public object.',
    steps: [
      { id: 'start', capability: 'manual_trigger', purpose: 'Start.', inputs: [], outputs: ['start.signal'], requiredUserSetup: [], configuration: {} },
      { id: 'fetch', capability: 'http_request', purpose: 'Read an object.', inputs: ['start.signal'], outputs: ['fetch.item'], requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://example.test/item', cardinality: 'one_object' } } },
      { id: 'select', capability: 'data_transform', purpose: 'Select id.', inputs: ['fetch.item'], outputs: ['select.item'], requiredUserSetup: [], configuration: { operation: 'select_fields', input: { kind: 'prior_step', reference: 'fetch.item', cardinality: 'one_object' }, mappings: [{ from: 'id', to: 'id', valueType: 'number' }] } },
      { id: 'output', capability: 'set_output', purpose: 'Return id.', inputs: ['select.item'], outputs: ['output.item'], requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'select.item', cardinality: 'one_object' }, mappings: [{ from: 'id', to: 'id', valueType: 'number' }] } },
    ], expectedOutput: { deliveryShape: 'one_object', fields: ['id'] }, requiredUserSetup: [],
  };
}

test('compiles only runtime-selected cards into a linear workflow', () => {
  const workflow = compileStepSpecification({ specification: specification(), nodeTypes: schemas() });
  assert.deepEqual(workflow.nodes.map((node) => [node.type, node.typeVersion]), [
    ['n8n-nodes-base.manualTrigger', 1], ['n8n-nodes-base.httpRequest', 4.4], ['n8n-nodes-base.set', 3.4], ['n8n-nodes-base.set', 3.4],
  ]);
  assert.equal(workflow.nodes[1].parameters.url, 'https://example.test/item');
  assert.equal(workflow.nodes[2].parameters.assignments.assignments[0].value, '={{ $json.id }}');
  assert.equal(Object.keys(workflow.connections).length, 3);
});

test('rejects an unresolved setup or unsupported transform before emitting JSON', () => {
  const pending = specification();
  pending.requiredUserSetup = ['service account'];
  assert.throws(() => compileStepSpecification({ specification: pending, nodeTypes: schemas() }), /user setup/);
  const arbitrary = specification();
  arbitrary.steps[2].configuration.operation = 'count_items';
  assert.throws(() => compileStepSpecification({ specification: arbitrary, nodeTypes: schemas() }), /select_fields/);
});
