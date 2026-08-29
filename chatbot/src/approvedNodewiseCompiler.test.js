'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  proposeNodewisePlan,
  reviewNodewisePlannerResult,
  approveNodewisePlan,
  compileApprovedNodewisePlan,
} = require('./approvedNodewiseCompiler');

const SECRET = 'test-only-approval-secret-value-32chars';
const SESSION = 'session-1';

function specification(userId = 1) {
  return {
    schemaVersion: '1.0',
    kind: 'nodewise_step_specification',
    goal: 'Summarize one public user and their Todo items.',
    requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['name', 'email', 'totalTodos', 'incompleteTodos'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'user', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: `https://jsonplaceholder.typicode.com/users/${userId}`, cardinality: 'one_object' } } },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: `https://jsonplaceholder.typicode.com/todos?userId=${userId}`, cardinality: 'items' } } },
      { id: 'summary', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'join_object_and_count_false_boolean', objectInput: { kind: 'prior_step', reference: 'user.item', cardinality: 'one_object' }, itemsInput: { kind: 'prior_step', reference: 'todos.items', cardinality: 'items' }, objectMappings: [{ from: 'name', to: 'name', valueType: 'string' }, { from: 'email', to: 'email', valueType: 'string' }], field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
    ],
  };
}

test('renders review from the exact specification later consumed by the compiler', () => {
  const review = proposeNodewisePlan(specification());
  assert.deepEqual(review.plan.externalDomains, ['jsonplaceholder.typicode.com']);
  assert.equal(review.plan.expectedOutput.fields.at(-1), 'incompleteTodos');
  assert.match(review.planFingerprint, /^[0-9a-f]{64}$/);
});

test('compiles only after explicit approval of the same specification and session', () => {
  const spec = specification();
  const approved = approveNodewisePlan(spec, { secret: SECRET, sessionId: SESSION });
  const result = compileApprovedNodewisePlan(spec, approved.approvalToken, { secret: SECRET, sessionId: SESSION });
  assert.equal(result.workflow.nodes.length, 4);
  assert.equal(result.planFingerprint, approved.planFingerprint);
});

test('rejects a changed specification even when the changed URL remains allowed', () => {
  const approved = approveNodewisePlan(specification(1), { secret: SECRET, sessionId: SESSION });
  assert.throws(
    () => compileApprovedNodewisePlan(specification(2), approved.approvalToken, { secret: SECRET, sessionId: SESSION }),
    /不屬於當前的計畫或執行環境/,
  );
});

test('rejects a missing approval token before compiler output exists', () => {
  assert.throws(
    () => compileApprovedNodewisePlan(specification(), null, { secret: SECRET, sessionId: SESSION }),
    /approval token 缺失/,
  );
});

test('returns a verifier-computed semantic diff for a revised ready planner result', () => {
  const first = specification(1);
  const revised = specification(2);
  const result = reviewNodewisePlannerResult({
    schemaVersion: '1.0',
    kind: 'nodewise_planner_result',
    outcome: 'ready_to_compile',
    goal: revised.goal,
    specification: revised,
  }, { previousSpecification: first });

  assert.equal(result.outcome, 'ready_to_compile');
  assert.equal(result.planDiff.level, 'low');
  assert.equal(result.planDiff.requiresExplicitApproval, true);
  assert.ok(result.planDiff.findings.some((finding) => finding.kind === 'url_path_changed'));
});

test('turns an unsupported planner result into a user-facing capability-gap response', () => {
  const result = reviewNodewisePlannerResult({
    schemaVersion: '1.0',
    kind: 'nodewise_planner_result',
    outcome: 'unsupported_capability',
    goal: '每 30 秒輪詢影片任務，完成後通知我。',
    requiredUserInputs: [],
    capabilityGaps: ['control.wait', 'delivery.notification'],
  });

  assert.equal(result.capabilityGap.state, 'capability_gap');
  assert.equal(result.capabilityGap.presentation.canRegisterRequest, true);
  assert.ok(result.capabilityGap.presentation.nearestAlternative.length > 0);
  assert.ok(result.capabilityGap.partial.needsManual.every((step) => step.placeholderBehaviour === 'stop_and_error'));
});

test('keeps a clarification-required planner result outside the compiler path', () => {
  const result = reviewNodewisePlannerResult({
    schemaVersion: '1.0',
    kind: 'nodewise_planner_result',
    outcome: 'clarification_required',
    goal: '建立摘要 workflow。',
    requiredUserInputs: ['請提供資料來源。'],
  });

  assert.equal(result.outcome, 'clarification_required');
  assert.equal(result.specification, undefined);
  assert.equal(result.planFingerprint, undefined);
});
