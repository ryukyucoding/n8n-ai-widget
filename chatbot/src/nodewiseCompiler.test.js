'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compileNodewiseSpecification, validateSpecification } = require('./nodewiseCompiler');

function todoSpecification() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Summarize one public user and their Todo items.', requiredUserSetup: [], expectedOutput: { deliveryShape: 'one_object', fields: ['name', 'email', 'totalTodos', 'incompleteTodos'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'user', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1', cardinality: 'one_object' } } },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'summary', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'join_object_and_count_false_boolean', objectInput: { kind: 'prior_step', reference: 'user.item', cardinality: 'one_object' }, itemsInput: { kind: 'prior_step', reference: 'todos.items', cardinality: 'items' }, objectMappings: [{ from: 'name', to: 'name', valueType: 'string' }, { from: 'email', to: 'email', valueType: 'string' }], field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
    ],
  };
}

test('compiles a declared Todo specification without a workflow template', () => {
  const workflow = compileNodewiseSpecification(todoSpecification());
  assert.deepEqual(workflow.nodes.map((node) => node.type), ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code']);
  assert.match(workflow.nodes[3].parameters.jsCode, /item\.json/);
  assert.match(workflow.nodes[3].parameters.jsCode, /\$\('Step 2: user'\)/);
  assert.equal(Object.keys(workflow.connections).length, 3);
});

test('refuses an unresolved credential-dependent plan before emitting JSON', () => {
  const specification = todoSpecification();
  specification.requiredUserSetup = ['Slack credential'];
  assert.throws(() => compileNodewiseSpecification(specification), /user setup/);
});

test('accepts the Sol user-2 plan and preserves its declared public endpoints', () => {
  const fixturePath = path.join(__dirname, '..', 'tests', 'nodewiseSpecs', 'sol-user2-todo-summary.json');
  const specification = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  const workflow = compileNodewiseSpecification(specification);

  assert.equal(workflow.nodes[1].parameters.url, 'https://jsonplaceholder.typicode.com/users/2');
  assert.equal(workflow.nodes[2].parameters.url, 'https://jsonplaceholder.typicode.com/todos?userId=2');
  assert.match(workflow.nodes[3].parameters.jsCode, /Step 2: fetch-user/);
});

test('refuses a plan whose declared output contract differs from its final transform', () => {
  const specification = todoSpecification();
  specification.expectedOutput.fields = ['name', 'email', 'totalTodos', 'completedTodos'];
  assert.throws(() => compileNodewiseSpecification(specification), /final step fields/);
});

test('refuses a public request that is outside the compiler host allowlist', () => {
  const specification = todoSpecification();
  specification.steps[1].configuration.url.reference = 'https://169.254.169.254/latest/meta-data/';
  assert.throws(() => compileNodewiseSpecification(specification), /private address|approved DNS hostname/);
});

test('refuses an unregistered public response schema even when its URL is public', () => {
  const specification = todoSpecification();
  specification.steps[1].configuration.url.reference = 'https://jsonplaceholder.typicode.com/posts/1';
  assert.throws(() => compileNodewiseSpecification(specification), /沒有登錄的回應 schema/);
});

test('refuses undeclared and type-incompatible fields before emitting a workflow', () => {
  const undeclared = todoSpecification();
  undeclared.steps[3].configuration.objectMappings[0].from = 'not_a_user_field';
  assert.throws(() => compileNodewiseSpecification(undeclared), /沒有宣告欄位 not_a_user_field/);

  const incompatible = todoSpecification();
  incompatible.steps[3].configuration.field = 'title';
  assert.throws(() => compileNodewiseSpecification(incompatible), /型別是 string.*需要 boolean/);
});

test('set_output can only project fields produced by its preceding transform', () => {
  const specification = todoSpecification();
  specification.expectedOutput.fields = ['name', 'incompleteTodos'];
  specification.steps.push({
    id: 'output', capability: 'set_output', requiredUserSetup: [],
    configuration: {
      input: { kind: 'prior_step', reference: 'summary.response', cardinality: 'one_object' },
      mappings: [
        { from: 'name', to: 'name', valueType: 'string' },
        { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' },
      ],
    },
  });
  const workflow = compileNodewiseSpecification(specification);
  assert.equal(workflow.nodes.at(-1).type, 'n8n-nodes-base.set');

  specification.steps.at(-1).configuration.mappings[1].from = 'missingAggregateField';
  assert.throws(() => compileNodewiseSpecification(specification), /沒有宣告欄位 missingAggregateField/);
});

function setFieldsSpecification() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Shape one public user into a fixed contract.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['name', 'status', 'rank', 'active'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'user', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1', cardinality: 'one_object' } } },
      { id: 'shape', capability: 'data_transform', requiredUserSetup: [], configuration: {
        operation: 'set_fields',
        input: { kind: 'prior_step', reference: 'user.response', cardinality: 'one_object' },
        mappings: [
          { to: 'name', valueType: 'string', source: { kind: 'input_field', field: 'name' } },
          { to: 'status', valueType: 'string', source: { kind: 'literal', value: 'active' } },
          { to: 'rank', valueType: 'number', source: { kind: 'literal', value: 1 } },
          { to: 'active', valueType: 'boolean', source: { kind: 'literal', value: true } },
        ],
      } },
    ],
  };
}

test('set_fields compiles input-field copies and typed literals into one Set node', () => {
  const workflow = compileNodewiseSpecification(setFieldsSpecification());
  const setNode = workflow.nodes.at(-1);
  assert.equal(setNode.type, 'n8n-nodes-base.set');
  const rows = setNode.parameters.assignments.assignments;
  assert.deepEqual(rows.find((r) => r.name === 'name'), { name: 'name', value: '={{ $json.name }}', type: 'string' });
  assert.deepEqual(rows.find((r) => r.name === 'status'), { name: 'status', value: 'active', type: 'string' });
  // PROVISIONAL: number literal is emitted as a raw JS number. The exact shape a
  // real n8n Set node stores for a fixed number is not yet pinned by a runtime
  // fixture (brain contract) — this asserts the compiler's chosen shape, not
  // runtime-verified n8n behaviour.
  assert.deepEqual(rows.find((r) => r.name === 'rank'), { name: 'rank', value: 1, type: 'number' });
  assert.deepEqual(rows.find((r) => r.name === 'active'), { name: 'active', value: true, type: 'boolean' });
});

test('set_fields rejects a duplicate target field', () => {
  const spec = setFieldsSpecification();
  spec.steps[2].configuration.mappings[1].to = 'name';
  assert.throws(() => compileNodewiseSpecification(spec), /duplicates an earlier mapping target/);
});

test('set_fields rejects an input-field copy that is not a declared source field', () => {
  const spec = setFieldsSpecification();
  spec.steps[2].configuration.mappings[0].source.field = 'not_a_user_field';
  assert.throws(() => compileNodewiseSpecification(spec), /沒有宣告欄位 not_a_user_field/);
});

test('set_fields rejects a field copy whose valueType differs from the source', () => {
  const spec = setFieldsSpecification();
  spec.steps[2].configuration.mappings[0].valueType = 'number';
  assert.throws(() => compileNodewiseSpecification(spec), /需要 number/);
});

test('set_fields rejects a literal whose JS type does not match its valueType', () => {
  const spec = setFieldsSpecification();
  spec.steps[2].configuration.mappings[2].source.value = 'not-a-number';
  assert.throws(() => compileNodewiseSpecification(spec), /must be a finite number literal/);

  const infinite = setFieldsSpecification();
  infinite.steps[2].configuration.mappings[2].source.value = Infinity;
  assert.throws(() => compileNodewiseSpecification(infinite), /must be a finite number literal/);
});

test('set_fields rejects an expression string masquerading as a literal', () => {
  const spec = setFieldsSpecification();
  spec.steps[2].configuration.mappings[1].source.value = '={{ $json.name }}';
  assert.throws(() => compileNodewiseSpecification(spec), /must not be an n8n expression/);
});

test('set_fields rejects object, array, and null literals', () => {
  for (const bad of [{ a: 1 }, [1], null]) {
    const spec = setFieldsSpecification();
    spec.steps[2].configuration.mappings[1].source.value = bad;
    assert.throws(() => compileNodewiseSpecification(spec), /must be a string literal/);
  }
});

test('set_fields rejects mixed, extra, and unknown source shapes', () => {
  const mixed = setFieldsSpecification();
  mixed.steps[2].configuration.mappings[0].source = { kind: 'input_field', field: 'name', value: 'x' };
  assert.throws(() => compileNodewiseSpecification(mixed), /unsupported key value for input_field/);

  const unknown = setFieldsSpecification();
  unknown.steps[2].configuration.mappings[0].source = { kind: 'expression', field: 'name' };
  assert.throws(() => compileNodewiseSpecification(unknown), /source\.kind is unsupported/);
});

test('set_fields rejects an items input', () => {
  const spec = setFieldsSpecification();
  spec.steps[1].configuration.url.reference = 'https://jsonplaceholder.typicode.com/todos?userId=1';
  spec.steps[1].configuration.url.cardinality = 'items';
  spec.steps[2].configuration.input.cardinality = 'items';
  spec.steps[2].configuration.mappings = [{ to: 'status', valueType: 'string', source: { kind: 'literal', value: 'x' } }];
  spec.expectedOutput.fields = ['status'];
  assert.throws(() => compileNodewiseSpecification(spec), /set_fields requires one_object input/);
});

test('validateSpecification is idempotent and preserves set_fields tagged mappings', () => {
  const once = validateSpecification(setFieldsSpecification());
  const twice = validateSpecification(once);
  assert.deepEqual(twice, once);
  const shapeStep = once.steps.find((step) => step.configuration.operation === 'set_fields');
  assert.deepEqual(shapeStep.configuration.mappings[0], {
    to: 'name', valueType: 'string', source: { kind: 'input_field', field: 'name' },
  });
  assert.deepEqual(shapeStep.configuration.mappings[1], {
    to: 'status', valueType: 'string', source: { kind: 'literal', value: 'active' },
  });
});

test('set_fields rejects an extra top-level mapping key', () => {
  const spec = setFieldsSpecification();
  spec.steps[2].configuration.mappings[0].extra = 'nope';
  assert.throws(() => compileNodewiseSpecification(spec), /has unsupported key extra/);
});
