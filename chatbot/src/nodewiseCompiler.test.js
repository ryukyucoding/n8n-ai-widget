'use strict';

const assert = require('node:assert/strict');
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
