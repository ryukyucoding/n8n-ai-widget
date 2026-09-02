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
  spec.steps[2].configuration.keep = 'lastItems';
  assert.throws(() => compileNodewiseSpecification(spec), /has unsupported key keep/);
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
