'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { NODEWISE_PLANNER_RESULT_PROMPT } = require('./nodewisePlannerPrompt');

test('planner prompt defines mutually exclusive readiness outcomes', () => {
  for (const outcome of ['ready_to_compile', 'clarification_required', 'unsupported_capability']) {
    assert.match(NODEWISE_PLANNER_RESULT_PROMPT, new RegExp(outcome));
  }
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Do not emit raw n8n workflow JSON/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /omit specification completely/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /final step must produce exactly expectedOutput\.fields/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /jsonplaceholder\.typicode\.com\/users\/:id/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /completed: boolean/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Every mapping.*valueType/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /"incompleteTodos", "to": "incompleteTodos", "valueType": "number"/);
});

test('planner prompt documents the sort_items transform contract', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /sort_items/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /"ascending" \| "descending"/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /cardinality items/);
});
