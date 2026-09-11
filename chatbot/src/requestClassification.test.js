'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySpecialRequest } = require('./requestClassification');

test('arbitrary step-count requests are unsupported', () => {
  for (const message of ['改成 8 步', '改成8步', 'Change it to 8 steps']) {
    const result = classifySpecialRequest(message);
    assert.equal(result.outcome, 'unsupported_capability');
    assert.match(result.detailZh, /no-op/);
  }
});

test('todo/network contradiction requests require clarification', () => {
  for (const message of [
    '抓取 todos，但不要發出任何網路請求',
    'Fetch todos without any network request',
  ]) {
    const result = classifySpecialRequest(message);
    assert.equal(result.outcome, 'clarification_required');
    assert.match(result.detailEn, /HTTP|network/i);
  }
});

test('ordinary meaningful requests are not preclassified', () => {
  assert.equal(classifySpecialRequest('再加上去重步驟'), null);
  assert.equal(classifySpecialRequest('Change the limit to 10.'), null);
});
