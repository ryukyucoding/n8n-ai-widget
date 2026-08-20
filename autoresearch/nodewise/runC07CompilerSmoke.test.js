'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { c07Specification } = require('./runC07CompilerSmoke');

test('declares the user object and Todo item inputs separately', () => {
  const summary = c07Specification().steps[3].configuration;
  assert.equal(summary.objectInput.reference, 'user.item');
  assert.equal(summary.itemsInput.reference, 'todos.items');
  assert.deepEqual(summary.objectMappings.map((mapping) => mapping.to), ['name', 'email']);
});
