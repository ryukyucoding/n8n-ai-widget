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

test('accepts an unsupported result with no missing user input yet', () => {
  const result = validatePlannerEnvelope({
    schemaVersion: '1.0', kind: 'nodewise_planner_result', outcome: 'unsupported_capability',
    goal: 'Generate a video and upload it to Drive.', requiredUserInputs: [],
    capabilityGaps: ['authenticated POST', 'bounded polling', 'binary upload'],
  });
  assert.deepEqual(result.requiredUserInputs, []);
  assert.equal(result.capabilityGaps.length, 3);
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

// --- 迴歸：驗證必須冪等 ---
// 2026-08-29 的實際缺陷：requestNodewisePlannerResult 回傳的是 validatePlannerEnvelope 的
// 輸出（已被剝掉 schemaVersion 與 kind），planFromUserRequest 再把它交給
// reviewNodewisePlannerResult，而那支函式開頭又驗一次 → ready_to_compile 100% 失敗。
//
// 當時整套測試全綠，因為每個測試都餵「原始 envelope」，沒有人餵「驗證過的輸出」——
// 也就是產品實際走的形狀。這兩條測試補的就是那個接縫。

test('驗證的輸出可以再次通過驗證（產品路徑會這樣用）', () => {
  const ready = {
    schemaVersion: '1.0', kind: 'nodewise_planner_result', outcome: 'ready_to_compile',
    goal: 'g',
    specification: {
      schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'g',
      requiredUserSetup: [],
      expectedOutput: { deliveryShape: 'one_object', fields: ['name'] },
      steps: [
        { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
        { id: 'src', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET',
          url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/5', cardinality: 'one_object' } } },
        { id: 'pick', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'select_fields',
          input: { kind: 'prior_step', reference: 'src.response', cardinality: 'one_object' },
          mappings: [{ from: 'name', to: 'name', valueType: 'string' }] } },
      ],
    },
  };
  const once = validatePlannerEnvelope(ready);
  assert.doesNotThrow(() => validatePlannerEnvelope(once),
    '驗證過的結果再驗一次必須通過，否則產品路徑會 100% 失敗');
  assert.equal(validatePlannerEnvelope(once).outcome, 'ready_to_compile');
});

test('非 ready_to_compile 的結果同樣冪等', () => {
  for (const raw of [
    { schemaVersion: '1.0', kind: 'nodewise_planner_result', outcome: 'clarification_required',
      goal: 'g', requiredUserInputs: ['要抓哪個網址'], capabilityGaps: [] },
    { schemaVersion: '1.0', kind: 'nodewise_planner_result', outcome: 'unsupported_capability',
      goal: 'g', requiredUserInputs: [], capabilityGaps: ['delivery.smtp_email_draft'] },
  ]) {
    const once = validatePlannerEnvelope(raw);
    assert.doesNotThrow(() => validatePlannerEnvelope(once), `${raw.outcome} 必須冪等`);
  }
});
