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
    'n8n-nodes-base.code': { versions: { '2': descriptor } },
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

test('compiles a bounded item-wrapper-aware boolean aggregation', () => {
  const spec = specification();
  spec.steps.splice(2, 1, {
    id: 'count', capability: 'data_transform', purpose: 'Count incomplete records.', inputs: ['fetch.item'], outputs: ['count.summary'], requiredUserSetup: [],
    configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'fetch.item', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' },
  });
  spec.steps.splice(3, 1);
  spec.expectedOutput.fields = ['totalTodos', 'incompleteTodos'];
  const workflow = compileStepSpecification({ specification: spec, nodeTypes: schemas() });
  const code = workflow.nodes[2];
  assert.deepEqual([code.type, code.typeVersion], ['n8n-nodes-base.code', 2]);
  assert.match(code.parameters.jsCode, /item\.json/);
  assert.match(code.parameters.jsCode, /record\.completed === false/);
});

test('rejects an unresolved setup or unsupported transform before emitting JSON', () => {
  const pending = specification();
  pending.requiredUserSetup = ['service account'];
  assert.throws(() => compileStepSpecification({ specification: pending, nodeTypes: schemas() }), /user setup/);
  const arbitrary = specification();
  arbitrary.steps[2].configuration.operation = 'count_items';
  assert.throws(() => compileStepSpecification({ specification: arbitrary, nodeTypes: schemas() }), /does not support/);
});
