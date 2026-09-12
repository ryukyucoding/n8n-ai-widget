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

test('planner prompt documents the bounded schedule trigger contract', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /schedule_trigger/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /minutes 1-59/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /must never be combined with a manual_trigger/);
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
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /"firstItems" \| "lastItems"/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /defaults to "firstItems"/);
});

test('planner prompt documents the slice_items transform contract', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /slice_items/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /offset.*0 to 100000/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /contiguous window/);
});

test('planner prompt documents the rename_keys transform contract', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /rename_keys/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /renames one or more fields/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /never a one_object input/);
});

test('planner prompt enforces language mirroring rule for human-readable fields', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Language mirroring rule/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /same language as the user's request/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Traditional Chinese when the user asks in Chinese/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Do NOT blindly copy the English example goal/);
});

test('planner prompt documents strict operation selection (count vs join, set_output final)', () => {
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Operation selection \(strict\)/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Prefer count_false_boolean for pure counting/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /objectMappings must then contain 1 to 20 .* and must never be empty/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /Never add an http_request step whose response no later step uses/);
  // items-only transforms are intermediate; count must be followed by set_output
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /sort_items, limit_items, remove_duplicates, and rename_keys .* always intermediate, never the final step/);
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /count_false_boolean outputs one_object but must NOT be the final step; follow it with a set_output/);
  // one_object-producing join/select_fields MAY be final when fields already match
  assert.match(NODEWISE_PLANNER_RESULT_PROMPT, /join_object_and_count_false_boolean and select_fields produce one_object and MAY be the final step/);
});
