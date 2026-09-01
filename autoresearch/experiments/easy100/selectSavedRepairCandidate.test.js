'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isMechanicalOnly } = require('./selectSavedRepairCandidate');

test('selects only categories handled by the local mechanical repair skill', () => {
  assert.equal(isMechanicalOnly({ type_version: 1, parameter_schema: 2 }), true);
  assert.equal(isMechanicalOnly({ node_type: 1 }), false);
  assert.equal(isMechanicalOnly({}), false);
});
