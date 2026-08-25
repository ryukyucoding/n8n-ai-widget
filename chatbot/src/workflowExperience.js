'use strict';

const STATES = Object.freeze({
  INTAKE: 'intake',
  CLARIFICATION_REQUIRED: 'clarification_required',
  CAPABILITY_GAP: 'capability_gap',
  PLAN_READY: 'plan_ready',
  STATIC_VALIDATION_FAILED: 'static_validation_failed',
  SETUP_REQUIRED: 'setup_required',
  CONFIRM_EXTERNAL_WRITE: 'confirm_external_write',
  READY_TO_CREATE: 'ready_to_create',
  CREATED_DRAFT: 'created_draft',
  READY_TO_RUN: 'ready_to_run',
  EXECUTION_PASSED: 'execution_passed',
  EXECUTION_FAILED: 'execution_failed',
});

function stateForPlannerResult(result) {
  if (result.outcome === 'clarification_required') return STATES.CLARIFICATION_REQUIRED;
  if (result.outcome === 'unsupported_capability') return STATES.CAPABILITY_GAP;
  if (result.outcome === 'ready_to_compile') return STATES.PLAN_READY;
  throw new Error(`unsupported planner outcome: ${result.outcome}`);
}

function nextStateAfterStaticValidation({ passed, setupRequirements = [], requiresConfirmation = false }) {
  if (!passed) return STATES.STATIC_VALIDATION_FAILED;
  if (setupRequirements.length > 0) return STATES.SETUP_REQUIRED;
  if (requiresConfirmation) return STATES.CONFIRM_EXTERNAL_WRITE;
  return STATES.READY_TO_CREATE;
}

function userActionForState(state) {
  const actions = {
    [STATES.CLARIFICATION_REQUIRED]: 'answer_questions',
    [STATES.CAPABILITY_GAP]: 'save_request_or_switch_mode',
    [STATES.PLAN_READY]: 'review_plan',
    [STATES.STATIC_VALIDATION_FAILED]: 'review_validation_findings',
    [STATES.SETUP_REQUIRED]: 'configure_credentials_and_fields',
    [STATES.CONFIRM_EXTERNAL_WRITE]: 'confirm_external_write',
    [STATES.READY_TO_CREATE]: 'create_workflow',
    [STATES.CREATED_DRAFT]: 'open_in_n8n_setup',
    [STATES.READY_TO_RUN]: 'run_in_n8n',
    [STATES.EXECUTION_FAILED]: 'inspect_execution_and_retry',
    [STATES.EXECUTION_PASSED]: 'save_or_activate_workflow',
  };
  return actions[state] || null;
}

module.exports = { STATES, stateForPlannerResult, nextStateAfterStaticValidation, userActionForState };
