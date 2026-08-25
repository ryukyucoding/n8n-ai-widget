'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { sanitizeCreateWorkflowPayload } = require('./workflowCreatePayload');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Create sanitizer removes unsupported root metadata without changing allowed content', () => {
  const nodes = [{ parameters: { nested: { keep: true } } }];
  const connections = { source: { main: [[{ target: 'target' }]] } };
  const settings = { executionOrder: 'v1' };
  const input = {
    name: 'fixture',
    nodes,
    connections,
    settings,
    active: false,
    meta: { internal: true },
    version: 1,
    versionId: 'read-only',
    id: 'read-only',
  };
  const original = clone(input);
  const output = sanitizeCreateWorkflowPayload(input);
  assert.strictEqual(output.nodes, nodes);
  assert.strictEqual(output.connections, connections);
  assert.strictEqual(output.settings, settings);
  for (const key of ['active', 'meta', 'version', 'versionId', 'id']) {
    assert.equal(Object.hasOwn(output, key), false);
  }
  assert.deepEqual(input, original);
});

test('formal Create route imports and invokes the shared sanitizer', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(indexSource, /require\('\.\/workflowCreatePayload'\)/);
  assert.match(indexSource, /sanitizeCreateWorkflowPayload\(workflowJson\)/);
});

test('shared sanitizer is dependency-free and has no environment or network access', () => {
  const source = fs.readFileSync(path.join(__dirname, 'workflowCreatePayload.js'), 'utf8');
  assert.doesNotMatch(source, /require\(|process\.|fetch\(|https?:\/\/|api[_-]?key|secret/i);
});
