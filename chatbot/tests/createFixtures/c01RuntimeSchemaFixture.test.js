'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { toProvisionWorkflow } = require('./c01FixtureIntegrity');
const RUNTIME_SCHEMAS = require('../../schemas/runtime_node_schemas.json');
const { sanitizeCreateWorkflowPayload } = require('../../src/workflowCreatePayload');

test('compiled C01 payload has runtime-supported node IDs, types, and versions', () => {
  const payload = toProvisionWorkflow();
  assert.deepEqual(payload, sanitizeCreateWorkflowPayload(payload));
  for (const node of payload.nodes) {
    const descriptor = RUNTIME_SCHEMAS.nodeTypes[node.type];
    assert.equal(typeof descriptor, 'object');
    assert.equal(Object.hasOwn(descriptor.versions, String(node.typeVersion)), true);
    assert.match(node.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(Object.hasOwn(node, 'fixtureKey'), false);
  }
});
