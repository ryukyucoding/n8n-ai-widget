'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('./conversationAcceptance');

test('acceptance summary exposes semantics but not raw assistant text or credentials', () => {
  const summary = summarize('sample', {
    httpStatus: 200,
    data: {
      conversationId: 'opaque-id',
      outcome: 'ready_to_compile',
      assistantMessage: 'Planned safely',
      inputRedacted: false,
      view: {
        status: 'ready_to_confirm',
        planSpec: {
          goal: 'A goal',
          steps: [
            { capability: 'sort_items', configuration: { operation: 'sort_items', order: 'descending', field: 'id' } },
            { capability: 'limit_items', configuration: { operation: 'limit_items', limit: 10 } },
          ],
        },
      },
    },
  }, 'opaque-id');
  assert.equal(summary.case, 'sample');
  assert.equal(summary.sameConversation, true);
  assert.deepEqual(summary.operations, ['sort_items', 'limit_items']);
  assert.deepEqual(summary.sortOrder, ['descending']);
  assert.deepEqual(summary.limit, [10]);
  assert.equal(summary.stepCount, 2);
  assert.equal(summary.planPresent, true);
  assert.equal('assistantMessage' in summary, false);
});

test('empty or failed response is summarized without throwing', () => {
  assert.deepEqual(summarize('failed', null), { case: 'failed', json: false });
});
