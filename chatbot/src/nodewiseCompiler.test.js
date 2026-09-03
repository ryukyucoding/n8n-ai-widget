'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compileNodewiseSpecification } = require('./nodewiseCompiler');

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

function sortSpec() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Count false completed among todos sorted by id.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'ordered', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'sort_items', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, field: 'id', order: 'ascending' } },
      { id: 'summary', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'ordered.response', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
      { id: 'output', capability: 'set_output', requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'summary.response', cardinality: 'one_object' }, mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }, { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' }] } },
    ],
  };
}

test('sort_items compiles to an n8n Sort node with the schema-verified simple shape', () => {
  const workflow = compileNodewiseSpecification(sortSpec());
  const sortNode = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.sort');
  assert.ok(sortNode, 'a Sort node is emitted');
  assert.deepEqual(sortNode.parameters, { type: 'simple', sortFieldsUi: { sortField: [{ fieldName: 'id', order: 'ascending' }] } });
});

test('sort_items supports ascending and descending order', () => {
  for (const order of ['ascending', 'descending']) {
    const spec = sortSpec();
    spec.steps[2].configuration.order = order;
    const workflow = compileNodewiseSpecification(spec);
    assert.equal(workflow.nodes.find((node) => node.type === 'n8n-nodes-base.sort').parameters.sortFieldsUi.sortField[0].order, order);
  }
});

test('sort_items rejects an unknown order value', () => {
  for (const bad of ['asc', 'random', '', null, 1]) {
    const spec = sortSpec();
    spec.steps[2].configuration.order = bad;
    assert.throws(() => compileNodewiseSpecification(spec), /order must be ascending or descending/);
  }
});

test('sort_items rejects a field not declared by the source schema', () => {
  const spec = sortSpec();
  spec.steps[2].configuration.field = 'not_a_declared_field';
  assert.throws(() => compileNodewiseSpecification(spec), /沒有宣告欄位 not_a_declared_field/);
});

test('sort_items rejects an extra configuration key', () => {
  const spec = sortSpec();
  spec.steps[2].configuration.direction = 'ascending';
  assert.throws(() => compileNodewiseSpecification(spec), /has unsupported key direction/);
});

test('sort_items rejects a one_object input', () => {
  const spec = sortSpec();
  spec.steps[1].configuration.url.reference = 'https://jsonplaceholder.typicode.com/users/1';
  spec.steps[1].configuration.url.cardinality = 'one_object';
  spec.steps[2].configuration.input.cardinality = 'one_object';
  spec.steps[2].configuration.field = 'name';
  assert.throws(() => compileNodewiseSpecification(spec), /sort_items requires items input/);
});

test('sort_items preserves the input item schema for the following step', () => {
  // the downstream count uses the boolean field completed, which must survive the sort
  const workflow = compileNodewiseSpecification(sortSpec());
  assert.ok(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.code'));
  const spec = sortSpec();
  spec.steps[3].configuration.field = 'not_a_declared_field';
  assert.throws(() => compileNodewiseSpecification(spec), /沒有宣告欄位 not_a_declared_field/);
});

test('sort_items cannot be the final one_object step', () => {
  const spec = {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Sort only, no final one_object.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['completed'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'ordered', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'sort_items', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, field: 'id', order: 'ascending' } },
    ],
  };
  assert.throws(() => compileNodewiseSpecification(spec), /final step must produce declared output fields/);
});

function dedupSpec() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Count false completed among unique-userId todos.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'unique', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'remove_duplicates', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, field: 'userId' } },
      { id: 'summary', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'unique.response', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
      { id: 'output', capability: 'set_output', requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'summary.response', cardinality: 'one_object' }, mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }, { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' }] } },
    ],
  };
}

test('remove_duplicates compiles to a v2 Remove Duplicates node with the schema-verified selected-field shape', () => {
  const workflow = compileNodewiseSpecification(dedupSpec());
  const node = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.removeDuplicates');
  assert.ok(node, 'a Remove Duplicates node is emitted');
  assert.equal(node.typeVersion, 2);
  assert.deepEqual(node.parameters, { operation: 'removeDuplicateInputItems', compare: 'selectedFields', fieldsToCompare: 'userId' });
});

test('remove_duplicates rejects an extra configuration key', () => {
  const spec = dedupSpec();
  spec.steps[2].configuration.order = 'ascending';
  assert.throws(() => compileNodewiseSpecification(spec), /has unsupported key order/);
});

test('remove_duplicates rejects a one_object input', () => {
  const spec = dedupSpec();
  spec.steps[1].configuration.url.reference = 'https://jsonplaceholder.typicode.com/users/1';
  spec.steps[1].configuration.url.cardinality = 'one_object';
  spec.steps[2].configuration.input.cardinality = 'one_object';
  spec.steps[2].configuration.field = 'name';
  assert.throws(() => compileNodewiseSpecification(spec), /remove_duplicates requires items input/);
});

test('remove_duplicates rejects a field not declared by the source schema', () => {
  const spec = dedupSpec();
  spec.steps[2].configuration.field = 'not_a_declared_field';
  assert.throws(() => compileNodewiseSpecification(spec), /沒有宣告欄位 not_a_declared_field/);
});

test('remove_duplicates preserves the input item schema for the following step', () => {
  const workflow = compileNodewiseSpecification(dedupSpec());
  assert.ok(workflow.nodes.some((n) => n.type === 'n8n-nodes-base.code'));
  const spec = dedupSpec();
  spec.steps[3].configuration.field = 'not_a_declared_field';
  assert.throws(() => compileNodewiseSpecification(spec), /沒有宣告欄位 not_a_declared_field/);
});

test('remove_duplicates cannot be the final one_object step', () => {
  const spec = {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Dedupe only, no final one_object.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['completed'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'unique', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'remove_duplicates', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, field: 'userId' } },
    ],
  };
  assert.throws(() => compileNodewiseSpecification(spec), /final step must produce declared output fields/);
});
