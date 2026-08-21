'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compilePlannerEnvelope, validatePlannerEnvelope } = require('./nodewisePlannerEnvelope');

test('keeps unresolved video automation requirements out of the compiler', () => {
  const result = validatePlannerEnvelope({
    schemaVersion: '1.0', kind: 'nodewise_planner_result', outcome: 'clarification_required',
    goal: 'Generate a video, upload it to Drive, and notify the user.',
    requiredUserInputs: ['video provider and API credential', 'Google Drive folder and credential', 'notification channel and recipient'],
    capabilityGaps: ['bounded polling', 'binary upload', 'human approval'],
  });
  assert.equal(result.outcome, 'clarification_required');
  assert.equal(result.requiredUserInputs.length, 3);
});

test('refuses a non-ready planner result that tries to smuggle in workflow instructions', () => {
  assert.throws(() => validatePlannerEnvelope({
    schemaVersion: '1.0', kind: 'nodewise_planner_result', outcome: 'unsupported_capability', goal: 'Delete records.',
    capabilityGaps: ['destructive Google Sheets write'], specification: { nodes: [] },
  }), /must not include/);
});

test('compiles only a ready planner result', () => {
  const result = compilePlannerEnvelope({
    schemaVersion: '1.0', kind: 'nodewise_planner_result', outcome: 'ready_to_compile', goal: 'Fetch user 2.',
    specification: {
      schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Fetch user 2.', requiredUserSetup: [],
      expectedOutput: { deliveryShape: 'one_object', fields: ['id'] },
      steps: [
        { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
        { id: 'user', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/2', cardinality: 'one_object' } } },
        { id: 'output', capability: 'set_output', requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'user.response', cardinality: 'one_object' }, mappings: [{ from: 'id', to: 'id', valueType: 'number' }] } },
      ],
    },
  });
  assert.equal(result.outcome, 'ready_to_compile');
  assert.equal(result.workflow.nodes.length, 3);
});
