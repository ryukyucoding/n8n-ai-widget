'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyExecutionOutput } = require('./executionAssertion');
const { normalizeAcceptanceContract } = require('./acceptanceContract');

function contract(executionAssertions) {
  return normalizeAcceptanceContract({
    userRequest: 'Verify externally supplied final execution output.',
    plannerResult: { execution_assertions: executionAssertions },
  });
}

test('reads values from n8n item wrappers rather than top-level item fields', () => {
  const result = verifyExecutionOutput({
    executionOutput: [{ json: { total: 2 }, pairedItem: { item: 0 } }],
    acceptanceContract: contract([{ path: 'total', required: true, expectedType: 'number', equals: 2 }]),
    executionSafety: true,
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.summary.itemCount, 1);
});

test('skips when assertions are absent or execution is not explicitly allowed', () => {
  const absent = verifyExecutionOutput({ executionOutput: [{ json: { total: 2 } }], acceptanceContract: contract([]), executionSafety: true });
  assert.deepEqual({ status: absent.status, reason: absent.reason }, { status: 'skipped', reason: 'no_execution_assertions' });

  const unsafe = verifyExecutionOutput({
    executionOutput: [{ json: { total: 2 } }],
    acceptanceContract: contract([{ path: 'total', expectedType: 'number' }]),
    executionSafety: false,
  });
  assert.deepEqual({ status: unsafe.status, reason: unsafe.reason }, { status: 'skipped', reason: 'execution_not_allowed' });
});

test('C07 fixture catches a wrong incomplete count and accepts the correct wrapper value', () => {
  const acceptanceContract = contract([{ path: 'incomplete_todos', required: true, expectedType: 'number', equals: 9, minimum: 0, maximum: 20 }]);
  const failed = verifyExecutionOutput({ executionOutput: [{ json: { incomplete_todos: 20 } }], acceptanceContract, executionSafety: { allowed: true } });
  assert.equal(failed.status, 'fail');
  assert.equal(failed.findings[0].rule, 'execution_assertion.equals');
  assert.equal(failed.findings[0].actualKind, 'number');

  const passed = verifyExecutionOutput({ executionOutput: [{ json: { incomplete_todos: 9 } }], acceptanceContract, executionSafety: { allowed: true } });
  assert.equal(passed.status, 'pass');
});

test('evaluates required, type, numeric, and item-count assertions across multiple items', () => {
  const result = verifyExecutionOutput({
    executionOutput: [{ json: { score: 3, active: true } }, { json: { score: 8, active: 'yes' } }],
    acceptanceContract: contract([
      { kind: 'item_count', equals: 2, minimum: 1, maximum: 2 },
      { path: 'score', required: true, expectedType: 'number', minimum: 4, maximum: 7 },
      { path: 'active', required: true, expectedType: 'boolean' },
      { path: 'requiredMissing', required: true },
    ]),
    executionSafety: true,
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(new Set(result.findings.map((finding) => finding.rule)), new Set([
    'execution_assertion.minimum', 'execution_assertion.maximum', 'execution_assertion.type', 'execution_assertion.required',
  ]));
  assert.equal(result.summary.itemCount, 2);
});

test('does not disclose execution values in failure findings or serializable reports', () => {
  const result = verifyExecutionOutput({
    executionOutput: [{ json: { email: 'person@example.test', token: 'very-sensitive-token', secret_value: 'hidden' } }],
    acceptanceContract: contract([
      { path: 'email', expectedType: 'number' },
      { path: 'token', expectedType: 'number' },
      { path: 'secret_value', expectedType: 'number' },
    ]),
    executionSafety: true,
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.status, 'fail');
  assert.doesNotMatch(serialized, /person@example\.test|very-sensitive-token|hidden/);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('skips unsafe output shape and keeps the acceptance contract unchanged', () => {
  const acceptanceContract = contract([{ path: 'total', expectedType: 'number' }]);
  const before = JSON.stringify(acceptanceContract);
  const result = verifyExecutionOutput({ executionOutput: { total: 2 }, acceptanceContract, executionSafety: true });
  assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'skipped', reason: 'unsafe_execution_output_shape' });
  assert.equal(JSON.stringify(acceptanceContract), before);
  assert.equal(result.summary.contractRevision, acceptanceContract.contractRevision);
});

test('skips non-declarative assertion input without evaluating it', () => {
  const result = verifyExecutionOutput({
    executionOutput: [{ json: { total: 2 } }],
    acceptanceContract: { contractRevision: 1, executionAssertions: [{ path: 'total', script: 'return true' }] },
    executionSafety: true,
  });
  assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'skipped', reason: 'invalid_execution_assertions' });
});
