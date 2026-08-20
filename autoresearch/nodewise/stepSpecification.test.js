'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseAndValidateStepSpecification } = require('./stepSpecification');

function fixture() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Read public records and count them.',
    steps: [
      { id: 'start', capability: 'manual_trigger', purpose: 'Start.', inputs: [], outputs: ['start.signal'], requiredUserSetup: [], configuration: {} },
      { id: 'fetch', capability: 'http_request', purpose: 'Read public records.', inputs: ['start.signal'], outputs: ['fetch.item'], requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://example.test/items', cardinality: 'one_object' } } },
      { id: 'select', capability: 'data_transform', purpose: 'Select fields.', inputs: ['fetch.item'], outputs: ['select.item'], requiredUserSetup: [], configuration: { operation: 'select_fields', input: { kind: 'prior_step', reference: 'fetch.item', cardinality: 'one_object' }, mappings: [{ from: 'id', to: 'id', valueType: 'number' }] } },
      { id: 'output', capability: 'set_output', purpose: 'Return result.', inputs: ['select.item'], outputs: ['output.result'], requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'select.item', cardinality: 'one_object' }, mappings: [{ from: 'id', to: 'id', valueType: 'number' }] } },
    ],
    expectedOutput: { deliveryShape: 'one_object', fields: ['count'] }, requiredUserSetup: [],
  };
}

test('accepts a compiler-ready specification without n8n parameter names', () => {
  const result = parseAndValidateStepSpecification(JSON.stringify(fixture()));
  assert.equal(result.kind, 'nodewise_step_specification');
  assert.equal(result.steps[1].configuration.method, 'GET');
});

test('rejects HTTP setup that is neither public nor user-provided', () => {
  const specification = fixture();
  specification.steps[1].configuration.url = { kind: 'invented', reference: 'https://example.test/items', cardinality: 'one_object' };
  assert.throws(() => parseAndValidateStepSpecification(JSON.stringify(specification)), /kind is not supported/);
});

test('rejects transforms that need semantic code generation', () => {
  const specification = fixture();
  specification.steps[2].configuration.operation = 'arbitrary_javascript';
  assert.throws(() => parseAndValidateStepSpecification(JSON.stringify(specification)), /operation is not supported/);
});
