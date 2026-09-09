'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePlanSpec, assertNoSecrets } = require('./planSpecSanitizer');

test('projects only structural fields (goal/expectedOutput.fields/steps.{id,capability,configuration})', () => {
  const out = sanitizePlanSpec({
    goal: 'read calendar',
    expectedOutput: { fields: ['totalTodos', 3, 'x'] },
    steps: [{ id: 's1', capability: 'http_request', configuration: { operation: 'getAll', url: { reference: 'https://jsonplaceholder.typicode.com/users/1' } }, extraneous: 'DROP_ME' }],
    topLevelJunk: 'DROP',
  });
  assert.deepEqual(Object.keys(out).sort(), ['expectedOutput', 'goal', 'steps']);
  assert.deepEqual(out.expectedOutput.fields, ['totalTodos', 'x']); // non-strings dropped
  assert.deepEqual(Object.keys(out.steps[0]).sort(), ['capability', 'configuration', 'id']); // extraneous dropped
  assert.equal(out.steps[0].configuration.url.reference, 'https://jsonplaceholder.typicode.com/users/1');
});

test('deep-drops forbidden keys anywhere in the spec (credential/token/secret/handle/boundName)', () => {
  const out = sanitizePlanSpec({
    goal: 'g',
    steps: [{ id: 's', capability: 'http_request', configuration: {
      operation: 'getAll',
      credentials: { googleCalendarOAuth2Api: { id: 'REALID', name: 'My Cal' } },
      nested: { token: 'abc', boundName: 'My Cal', keep: 'firstItems' },
    } }],
  });
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /credentials|REALID|My Cal|token|boundName/);
  assert.equal(out.steps[0].configuration.operation, 'getAll'); // structural kept
  assert.equal(out.steps[0].configuration.nested.keep, 'firstItems'); // non-forbidden kept
});

test('assertNoSecrets throws on JWT / bearer / long token values', () => {
  assert.throws(() => assertNoSecrets({ x: 'eyJhbGciOiJIUzI1NiJ9.payload' }), /secret/i);
  assert.throws(() => assertNoSecrets({ x: 'Bearer sk-abcdefghijklmnop' }), /secret/i);
  assert.throws(() => assertNoSecrets({ x: 'deadbeef'.repeat(6) }), /secret/i); // 48 hex
});

test('sanitizePlanSpec is fail-closed if a secret value survives in a structural field', () => {
  assert.throws(() => sanitizePlanSpec({ goal: 'eyJhbGciOiJIUzI1NiedqweqweqweJ9.aaaaaaaaaa', steps: [] }), /secret/i);
});

test('normal prose goal + public URL do not false-positive', () => {
  assert.doesNotThrow(() => sanitizePlanSpec({
    goal: '抓 user 1 的 todos，依 id 排序取前 5 筆，回報總數與未完成數',
    steps: [{ id: 's', capability: 'http_request', configuration: { url: { reference: 'https://jsonplaceholder.typicode.com/users/1/todos' } } }],
  }));
});

test('null/undefined spec -> null', () => {
  assert.equal(sanitizePlanSpec(null), null);
  assert.equal(sanitizePlanSpec(undefined), null);
});
