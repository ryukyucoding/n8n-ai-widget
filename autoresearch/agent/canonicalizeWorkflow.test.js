'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalizeWorkflow, PYTHON_SOURCE } = require('./canonicalizeWorkflow');

test('includes only runtime-proven connection-port normalization in the canonical path', () => {
  assert.match(PYTHON_SOURCE, /validate_connection_ports/);
  assert.match(PYTHON_SOURCE, /try:\n    validate_connection_ports\(workflow\)\nexcept StructuredValidationError:\n    pass/);
});

test('keeps canonical workflow data in memory after the Python boundary succeeds', () => {
  let input;
  const canonical = canonicalizeWorkflow({
    workflow: { name: 'Private workflow', nodes: [] },
    userRequest: 'Private request',
    spawn: (_python, _arguments, options) => {
      input = JSON.parse(options.input);
      return { status: 0, stdout: JSON.stringify({ name: 'Canonical workflow', nodes: [] }) };
    },
  });
  assert.equal(input.workflow.name, 'Private workflow');
  assert.equal(input.userRequest, 'Private request');
  assert.equal(canonical.name, 'Canonical workflow');
});

test('does not expose Python errors as a workflow or report payload', () => {
  assert.throws(() => canonicalizeWorkflow({
    workflow: { name: 'Private workflow', nodes: [] },
    spawn: () => ({ status: 1, stdout: '', stderr: 'private details' }),
  }), /canonicalization_failed/);
});
