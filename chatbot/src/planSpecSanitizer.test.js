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

test('configuration is an ALLOWLIST: only known nodewise keys survive; credential/unknown dropped', () => {
  const out = sanitizePlanSpec({
    goal: 'g',
    steps: [{ id: 's', capability: 'http_request', configuration: {
      operation: 'getAll',
      field: 'completed',
      url: { reference: 'https://jsonplaceholder.typicode.com/todos', cardinality: 'items' },
      credentials: { googleCalendarOAuth2Api: { id: 'REALID', name: 'My Cal' } }, // forbidden key
      nested: { token: 'abc', boundName: 'My Cal', keep: 'firstItems' },          // unknown key -> whole subtree dropped
    } }],
  });
  const cfg = out.steps[0].configuration;
  assert.deepEqual(Object.keys(cfg).sort(), ['field', 'operation', 'url']);
  assert.equal(cfg.operation, 'getAll');
  assert.equal(cfg.field, 'completed');
  assert.equal(cfg.url.reference, 'https://jsonplaceholder.typicode.com/todos');
  assert.doesNotMatch(JSON.stringify(out), /REALID|My Cal|token|boundName|nested/);
});

test('innocuous-key private data (query/filter/value/description/PII) is dropped by the allowlist', () => {
  const out = sanitizePlanSpec({
    goal: 'g',
    steps: [{ id: 's', capability: 'http_request', configuration: {
      operation: 'getAll',
      description: 'private note SSN 123-45-6789',
      filter: { email: 'alice@example.com' },
      value: 'some private value',
      query: 'q=confidential',
    } }],
  });
  assert.deepEqual(Object.keys(out.steps[0].configuration), ['operation']);
  assert.doesNotMatch(JSON.stringify(out), /123-45-6789|alice@example\.com|private|confidential/);
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
