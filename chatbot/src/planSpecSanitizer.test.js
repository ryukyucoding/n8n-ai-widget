'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePlanSpec, sanitizeConfiguration, assertNoSecrets } = require('./planSpecSanitizer');

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

// Config-survival: the sanitizer must be LOSSLESS for valid nodewise configs, or
// the plan becomes non-recompilable (brain2). Each valid config must round-trip.
test('config survival: http_request (url ref) round-trips', () => {
  const c = { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1', cardinality: 'one_object' } };
  assert.deepEqual(sanitizeConfiguration(c), c);
});

test('config survival: select_fields (input + mappings w/ valueType) round-trips', () => {
  const c = { operation: 'select_fields', input: { kind: 'step_reference', reference: 's1', cardinality: 'one_object' }, mappings: [{ from: 'name', to: 'name', valueType: 'string' }] };
  assert.deepEqual(sanitizeConfiguration(c), c);
});

test('config survival: count_false_boolean (input + field/total/falseCount) round-trips', () => {
  const c = { operation: 'count_false_boolean', input: { kind: 'step_reference', reference: 's1', cardinality: 'items' }, field: 'completed', totalField: 'total', falseCountField: 'incomplete' };
  assert.deepEqual(sanitizeConfiguration(c), c);
});

test('config survival: join (objectInput + itemsInput + objectMappings w/ valueType) round-trips', () => {
  const c = {
    operation: 'join_object_and_count_false_boolean',
    objectInput: { kind: 'step_reference', reference: 'u', cardinality: 'one_object' },
    itemsInput: { kind: 'step_reference', reference: 't', cardinality: 'items' },
    objectMappings: [{ from: 'name', to: 'userName', valueType: 'string' }],
    field: 'completed', totalField: 'total', falseCountField: 'incomplete',
  };
  assert.deepEqual(sanitizeConfiguration(c), c);
});

test('config survival: set_output (input + mappings w/ valueType) round-trips', () => {
  const c = { input: { kind: 'step_reference', reference: 'c', cardinality: 'one_object' }, mappings: [{ from: 'total', to: 'total', valueType: 'number' }] };
  assert.deepEqual(sanitizeConfiguration(c), c);
});

test('config survival: rename_keys renames {from,to} (no valueType) round-trips', () => {
  const c = { operation: 'rename_keys', input: { kind: 'step_reference', reference: 's', cardinality: 'items' }, renames: [{ from: 'id', to: 'todoId' }] };
  assert.deepEqual(sanitizeConfiguration(c), c);
});

test('config: valueType NOT added to renames entries', () => {
  const out = sanitizeConfiguration({ operation: 'rename_keys', renames: [{ from: 'a', to: 'b', valueType: 'string' }] });
  assert.deepEqual(out.renames, [{ from: 'a', to: 'b' }]); // valueType stripped for renames
});

test('full canonical spec round-trips losslessly (schemaVersion/kind/deliveryShape/requiredUserSetup preserved, no drift)', () => {
  const spec = {
    schemaVersion: '1.0',
    kind: 'nodewise_step_specification',
    goal: 'count incomplete todos for user 1',
    requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] },
    steps: [
      { id: 'trigger', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1/todos', cardinality: 'items' } } },
      { id: 'count', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'todos', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
    ],
  };
  assert.deepEqual(sanitizePlanSpec(spec), spec); // lossless -> recompilable, planner context complete
});
