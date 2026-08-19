'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getAuthoritativeRepairContext } = require('./getAuthoritativeRepairContext');

test('returns only Python-projected repair findings', () => {
  const findings = getAuthoritativeRepairContext({
    workflow: { name: 'Private workflow' },
    userRequest: 'Private request',
    spawn: (_python, _arguments, options) => {
      const input = JSON.parse(options.input);
      assert.equal(input.workflow.name, 'Private workflow');
      return { status: 0, stdout: JSON.stringify({ findings: [{ category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: 'test.node', parameterName: 'field' } }] }) };
    },
  });
  assert.deepEqual(findings, [{ category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: 'test.node', parameterName: 'field' } }]);
});

test('does not surface child-process details when the context fails', () => {
  assert.throws(() => getAuthoritativeRepairContext({
    workflow: { name: 'Private workflow' },
    spawn: () => ({ status: 1, stdout: '', stderr: 'private failure detail' }),
  }), /authoritative_repair_context_failed/);
});
