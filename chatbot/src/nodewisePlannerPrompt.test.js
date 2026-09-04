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

test('planner prompt documents the remove_duplicates transform contract', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /remove_duplicates/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /drops duplicate items/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /never a one_object input/);
});

test('planner prompt documents the limit_items transform contract', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /limit_items/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /integer 1 to 1000/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /cardinality items/);
});

test('planner prompt documents the rename_keys transform contract', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /rename_keys/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /renames one or more fields/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /never a one_object input/);
});
