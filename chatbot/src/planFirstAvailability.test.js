'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_PLANNER_APPROVAL_SECRET_LENGTH,
  enabledEnvironmentValue,
  planFirstAvailability,
} = require('./planFirstAvailability');

test('recognizes explicit enabled environment values only', () => {
  assert.equal(enabledEnvironmentValue('true'), true);
  assert.equal(enabledEnvironmentValue('YES'), true);
  assert.equal(enabledEnvironmentValue('0'), false);
  assert.equal(enabledEnvironmentValue(undefined), false);
});

test('plan-first stays unreachable when its independent flag is disabled', () => {
  const result = planFirstAvailability({
    runtimeCompilerEnabled: true,
    planFirstEnabled: false,
    secret: 'x'.repeat(MIN_PLANNER_APPROVAL_SECRET_LENGTH),
  });
  assert.deepEqual(result, {
    available: false,
    status: 404,
    error: 'Plan-first compiler is disabled.',
  });
});

test('plan-first requires the legacy compiler and a 32-character secret after enablement', () => {
  assert.equal(planFirstAvailability({
    runtimeCompilerEnabled: false,
    planFirstEnabled: true,
    secret: 'x'.repeat(MIN_PLANNER_APPROVAL_SECRET_LENGTH),
  }).status, 404);
  assert.equal(planFirstAvailability({
    runtimeCompilerEnabled: true,
    planFirstEnabled: true,
    secret: 'x'.repeat(MIN_PLANNER_APPROVAL_SECRET_LENGTH - 1),
  }).status, 503);
  assert.deepEqual(planFirstAvailability({
    runtimeCompilerEnabled: true,
    planFirstEnabled: true,
    secret: 'x'.repeat(MIN_PLANNER_APPROVAL_SECRET_LENGTH),
  }), { available: true, status: 200, error: null });
});
