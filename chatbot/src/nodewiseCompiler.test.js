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

function limitSpec() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Count false completed among the first 5 todos.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'recent', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'limit_items', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, limit: 5 } },
      { id: 'summary', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'recent.response', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
      { id: 'output', capability: 'set_output', requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'summary.response', cardinality: 'one_object' }, mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }, { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' }] } },
    ],
  };
}

test('limit_items compiles to an n8n Limit node with the schema-verified parameter shape', () => {
  const workflow = compileNodewiseSpecification(limitSpec());
  const limitNode = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.limit');
  assert.ok(limitNode, 'a Limit node is emitted');
  assert.deepEqual(limitNode.parameters, { maxItems: 5, keep: 'firstItems' });
  // limit is intermediate; the final one_object step is the set_output projection
  assert.equal(workflow.nodes.at(-1).type, 'n8n-nodes-base.set');
});

test('limit_items defaults keep to firstItems when the key is omitted', () => {
  const spec = limitSpec();
  assert.equal(spec.steps[2].configuration.keep, undefined);
  const limitNode = compileNodewiseSpecification(spec).nodes.find((node) => node.type === 'n8n-nodes-base.limit');
  assert.equal(limitNode.parameters.keep, 'firstItems');
});

test('limit_items emits keep=lastItems when requested', () => {
  const spec = limitSpec();
  spec.steps[2].configuration.keep = 'lastItems';
  const limitNode = compileNodewiseSpecification(spec).nodes.find((node) => node.type === 'n8n-nodes-base.limit');
  assert.deepEqual(limitNode.parameters, { maxItems: 5, keep: 'lastItems' });
});

test('limit_items explicit keep=firstItems is accepted', () => {
  const spec = limitSpec();
  spec.steps[2].configuration.keep = 'firstItems';
  const limitNode = compileNodewiseSpecification(spec).nodes.find((node) => node.type === 'n8n-nodes-base.limit');
  assert.equal(limitNode.parameters.keep, 'firstItems');
});

test('limit_items rejects an unknown keep value', () => {
  for (const bad of ['first', 'last', 'lastItem', '', null, 1, true]) {
    const spec = limitSpec();
    spec.steps[2].configuration.keep = bad;
    assert.throws(() => compileNodewiseSpecification(spec), /keep must be firstItems or lastItems/);
  }
});

test('limit_items accepts the boundary limits 1 and 1000', () => {
  for (const n of [1, 1000]) {
    const spec = limitSpec();
    spec.steps[2].configuration.limit = n;
    const workflow = compileNodewiseSpecification(spec);
    assert.equal(workflow.nodes.find((node) => node.type === 'n8n-nodes-base.limit').parameters.maxItems, n);
  }
});

test('limit_items rejects non-integer, zero, negative, and out-of-range limits', () => {
  for (const bad of [0, -1, 1001, 2.5, '5', null, true]) {
    const spec = limitSpec();
    spec.steps[2].configuration.limit = bad;
    assert.throws(() => compileNodewiseSpecification(spec), /limit must be an integer between 1 and 1000/);
  }
});

test('limit_items rejects an extra configuration key', () => {
  const spec = limitSpec();
  spec.steps[2].configuration.offset = 3;
  assert.throws(() => compileNodewiseSpecification(spec), /has unsupported key offset/);
});

test('limit_items rejects a one_object input', () => {
  const spec = limitSpec();
  spec.steps[1].configuration.url.reference = 'https://jsonplaceholder.typicode.com/users/1';
  spec.steps[1].configuration.url.cardinality = 'one_object';
  spec.steps[2].configuration.input.cardinality = 'one_object';
  assert.throws(() => compileNodewiseSpecification(spec), /limit_items requires items input/);
});

test('limit_items preserves the input item schema for the following step', () => {
  // the downstream count uses the boolean field 'completed', which must survive the limit
  const workflow = compileNodewiseSpecification(limitSpec());
  assert.ok(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.code'));
  // a field the source never declared is still rejected after the limit (no field invention)
  const spec = limitSpec();
  spec.steps[3].configuration.field = 'not_a_declared_field';
  assert.throws(() => compileNodewiseSpecification(spec), /沒有宣告欄位 not_a_declared_field/);
});

test('limit_items cannot be the final one_object step', () => {
  const spec = {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Limit only, no final one_object.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['completed'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'recent', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'limit_items', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, limit: 5 } },
    ],
  };
  assert.throws(() => compileNodewiseSpecification(spec), /final step must produce declared output fields/);
});

function renameSpec({ renames = [{ from: 'id', to: 'todoId' }] } = {}) {
  return {
    schemaVersion: '1.0',
    kind: 'nodewise_step_specification',
    goal: 'Rename todo keys and count incomplete todos.',
    requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'renamed', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'rename_keys', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, renames } },
      { id: 'summary', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'renamed.response', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
      { id: 'output', capability: 'set_output', requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'summary.response', cardinality: 'one_object' }, mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }, { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' }] } },
    ],
  };
}

test('rename_keys compiles valid todos id->todoId then count/set_output and asserts schema parameters', () => {
  const workflow = compileNodewiseSpecification(renameSpec());
  const renameNode = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.renameKeys');
  assert.ok(renameNode, 'a Rename Keys node is emitted');
  assert.equal(renameNode.typeVersion, 1);
  assert.deepEqual(renameNode.parameters, {
    keys: {
      key: [{ currentKey: 'id', newKey: 'todoId' }],
    },
    additionalOptions: {},
  });
  // rename_keys is intermediate; final one_object step is set_output
  assert.equal(workflow.nodes.at(-1).type, 'n8n-nodes-base.set');
});

test('rename_keys preserves field ordering deterministically and keeps value types', () => {
  const spec = renameSpec({
    renames: [
      { from: 'id', to: 'todoId' },
      { from: 'title', to: 'todoTitle' },
    ],
  });
  // downstream sort on renamed field todoId succeeds
  spec.steps[3] = {
    id: 'ordered', capability: 'data_transform', requiredUserSetup: [],
    configuration: { operation: 'sort_items', input: { kind: 'prior_step', reference: 'renamed.response', cardinality: 'items' }, field: 'todoId', order: 'ascending' },
  };
  spec.steps[4] = {
    id: 'summary', capability: 'data_transform', requiredUserSetup: [],
    configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'ordered.response', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' },
  };
  spec.steps.push({
    id: 'output', capability: 'set_output', requiredUserSetup: [],
    configuration: { input: { kind: 'prior_step', reference: 'summary.response', cardinality: 'one_object' }, mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }, { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' }] },
  });
  const workflow = compileNodewiseSpecification(spec);
  const renameNode = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.renameKeys');
  const sortNode = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.sort');
  const codeNode = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.code');
  assert.ok(renameNode, 'Rename Keys node is emitted');
  assert.ok(sortNode, 'Sort node is emitted');
  assert.ok(codeNode, 'Code node is emitted');
  // direct output-schema assertion: downstream sort verified and bound todoId
  assert.deepEqual(sortNode.parameters, {
    type: 'simple',
    sortFieldsUi: { sortField: [{ fieldName: 'todoId', order: 'ascending' }] },
  });
  // direct output-schema assertion: downstream count verified and bound completed
  assert.match(codeNode.parameters.jsCode, /record\.completed === false/);

  // downstream step cannot reference the original old key 'id' after it was renamed
  const badSpec = renameSpec({ renames: [{ from: 'id', to: 'todoId' }] });
  badSpec.steps[3] = {
    id: 'ordered', capability: 'data_transform', requiredUserSetup: [],
    configuration: { operation: 'sort_items', input: { kind: 'prior_step', reference: 'renamed.response', cardinality: 'items' }, field: 'id', order: 'ascending' },
  };
  assert.throws(() => compileNodewiseSpecification(badSpec), /沒有宣告欄位 id/);
});

test('rename_keys rejects a non-items input', () => {
  const spec = renameSpec();
  spec.steps[1].configuration.url.reference = 'https://jsonplaceholder.typicode.com/users/1';
  spec.steps[1].configuration.url.cardinality = 'one_object';
  spec.steps[2].configuration.input.cardinality = 'one_object';
  assert.throws(() => compileNodewiseSpecification(spec), /rename_keys requires items input/);
});

test('rename_keys rejects an undeclared from field', () => {
  const spec = renameSpec({ renames: [{ from: 'nonexistentField', to: 'safeTarget' }] });
  assert.throws(() => compileNodewiseSpecification(spec), /沒有宣告欄位 nonexistentField/);
});

test('rename_keys rejects collision where to matches an existing input field', () => {
  // Input has fields: userId, id, title, completed.
  // Renaming 'id' to 'title' collides with existing input field 'title'.
  const spec = renameSpec({ renames: [{ from: 'id', to: 'title' }] });
  assert.throws(() => compileNodewiseSpecification(spec), /collides with an existing input field/);
});

test('rename_keys explicitly rejects no-op renaming a field to itself', () => {
  const spec = renameSpec({ renames: [{ from: 'id', to: 'id' }] });
  assert.throws(
    () => compileNodewiseSpecification(spec),
    /from and to must be distinct: id cannot be renamed to itself/,
  );
});

test('rename_keys rejects chain renaming where a target is another input field', () => {
  // id -> userId, userId -> newUid: userId is an existing input field
  const spec = renameSpec({
    renames: [
      { from: 'id', to: 'userId' },
      { from: 'userId', to: 'newUid' },
    ],
  });
  assert.throws(() => compileNodewiseSpecification(spec), /collides with an existing input field/);
});

test('rename_keys rejects swap renaming between two input fields', () => {
  // id <-> userId: both targets exist in the original input field set
  const spec = renameSpec({
    renames: [
      { from: 'id', to: 'userId' },
      { from: 'userId', to: 'id' },
    ],
  });
  assert.throws(() => compileNodewiseSpecification(spec), /collides with an existing input field/);
});

test('rename_keys rejects duplicate target fields', () => {
  const spec = renameSpec({
    renames: [
      { from: 'id', to: 'duplicateTarget' },
      { from: 'title', to: 'duplicateTarget' },
    ],
  });
  assert.throws(() => compileNodewiseSpecification(spec), /duplicate target field duplicateTarget/);
});

test('rename_keys rejects duplicate source fields', () => {
  const spec = renameSpec({
    renames: [
      { from: 'id', to: 'target1' },
      { from: 'id', to: 'target2' },
    ],
  });
  assert.throws(() => compileNodewiseSpecification(spec), /duplicate source field id/);
});

test('rename_keys rejects extra configuration keys on the step', () => {
  const spec = renameSpec();
  spec.steps[2].configuration.extraOption = 'disallowed';
  assert.throws(() => compileNodewiseSpecification(spec), /has unsupported key extraOption/);
});

test('rename_keys rejects extra keys inside a rename entry', () => {
  const spec = renameSpec();
  spec.steps[2].configuration.renames = [{ from: 'id', to: 'todoId', valueType: 'number' }];
  assert.throws(() => compileNodewiseSpecification(spec), /has unsupported key valueType/);
});

test('rename_keys rejects dot notation and deep keys in from or to', () => {
  const specDotFrom = renameSpec({ renames: [{ from: 'level1.id', to: 'todoId' }] });
  assert.throws(() => compileNodewiseSpecification(specDotFrom), /must be a simple field identifier/);

  const specDotTo = renameSpec({ renames: [{ from: 'id', to: 'level1.todoId' }] });
  assert.throws(() => compileNodewiseSpecification(specDotTo), /must be a simple field identifier/);
});

test('rename_keys rejects an empty renames array', () => {
  const spec = renameSpec({ renames: [] });
  assert.throws(() => compileNodewiseSpecification(spec), /must contain 1 to 20 mappings/);
});

test('rename_keys cannot be the final one_object step', () => {
  const spec = {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Rename only, no final one_object.', requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['completed'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'renamed', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'rename_keys', input: { kind: 'prior_step', reference: 'todos.response', cardinality: 'items' }, renames: [{ from: 'id', to: 'todoId' }] } },
    ],
  };
  assert.throws(() => compileNodewiseSpecification(spec), /final step must produce declared output fields/);
});
