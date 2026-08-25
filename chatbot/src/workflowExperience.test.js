'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { STATES, stateForPlannerResult, nextStateAfterStaticValidation, userActionForState } = require('./workflowExperience');

test('surfaces missing information before any compiler action', () => {
  assert.equal(stateForPlannerResult({ outcome: 'clarification_required' }), STATES.CLARIFICATION_REQUIRED);
  assert.equal(userActionForState(STATES.CLARIFICATION_REQUIRED), 'answer_questions');
});

test('creates a credential-bound draft before asking the user to complete setup', () => {
  assert.equal(nextStateAfterStaticValidation({ passed: true, credentialDisposition: 'create_inactive_draft' }), STATES.READY_TO_CREATE_DRAFT);
  assert.equal(userActionForState(STATES.READY_TO_CREATE_DRAFT), 'create_inactive_draft');
});

test('requires explicit confirmation for an external write after setup is resolved', () => {
  assert.equal(nextStateAfterStaticValidation({ passed: true, requiresConfirmation: true }), STATES.CONFIRM_EXTERNAL_WRITE);
});

test('does not present a broken workflow as ready', () => {
  assert.equal(nextStateAfterStaticValidation({ passed: false }), STATES.STATIC_VALIDATION_FAILED);
});
