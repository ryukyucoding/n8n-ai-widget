'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { STATES, stateForPlannerResult, nextStateAfterStaticValidation, userActionForState } = require('./workflowExperience');

test('surfaces missing information before any compiler action', () => {
  assert.equal(stateForPlannerResult({ outcome: 'clarification_required' }), STATES.CLARIFICATION_REQUIRED);
  assert.equal(userActionForState(STATES.CLARIFICATION_REQUIRED), 'answer_questions');
});

test('routes an otherwise valid credential-bound workflow into setup', () => {
  assert.equal(nextStateAfterStaticValidation({ passed: true, setupRequirements: ['SMTP credential'] }), STATES.SETUP_REQUIRED);
});

test('requires explicit confirmation for an external write after setup is resolved', () => {
  assert.equal(nextStateAfterStaticValidation({ passed: true, requiresConfirmation: true }), STATES.CONFIRM_EXTERNAL_WRITE);
});

test('does not present a broken workflow as ready', () => {
  assert.equal(nextStateAfterStaticValidation({ passed: false }), STATES.STATIC_VALIDATION_FAILED);
});
