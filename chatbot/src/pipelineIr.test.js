'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePipelineIr } = require('./pipelineIr');

function baseIr() {
  return {
    version: '1.0',
    goal: 'Count incomplete todos',
    steps: [
      { id: 'start', kind: 'trigger.manual', outputShape: 'SingleItem<Empty>' },
      { id: 'todos', kind: 'source.http_get', inputShape: 'SingleItem<Empty>', outputShape: 'ItemList<Todo>', dependsOn: [{ step: 'start', sourcePort: 'main' }] },
      { id: 'summary', kind: 'transform.count_false_boolean', inputShape: 'ItemList<Todo>', outputShape: 'SingleItem<TodoSummary>', dependsOn: [{ step: 'todos', sourcePort: 'main' }] },
    ],
    expectedOutput: { fromStep: 'summary', shape: 'SingleItem<TodoSummary>', fields: ['totalTodos', 'incompleteTodos'] },
  };
}

test('accepts an ordered linear pipeline with explicit dependencies', () => {
  const result = validatePipelineIr(baseIr());
  assert.deepEqual(result.steps.map((step) => step.id), ['start', 'todos', 'summary']);
});

test('orders a DAG even when the input steps are not sorted', () => {
  const ir = baseIr();
  ir.steps = [ir.steps[2], ir.steps[0], ir.steps[1]];
  const result = validatePipelineIr(ir);
  assert.deepEqual(result.steps.map((step) => step.id), ['start', 'todos', 'summary']);
});

test('rejects a cycle before compiler work begins', () => {
  const ir = baseIr();
  ir.steps[0].inputShape = 'SingleItem<TodoSummary>';
  ir.steps[0].dependsOn = [{ step: 'summary' }];
  assert.throws(() => validatePipelineIr(ir), /cycle/);
});

test('rejects shape mismatches', () => {
  const ir = baseIr();
  ir.steps[2].inputShape = 'SingleItem<Todo>';
  assert.throws(() => validatePipelineIr(ir), /inputShape must match/);
});

test('rejects fan-in without an explicit merge policy', () => {
  const ir = baseIr();
  ir.steps.push({
    id: 'merge',
    kind: 'transform.merge',
    inputShape: 'ItemList<Todo>',
    outputShape: 'ItemList<Todo>',
    dependsOn: [{ step: 'todos' }, { step: 'todos-copy' }],
  });
  ir.steps.push({
    id: 'todos-copy',
    kind: 'transform.copy',
    inputShape: 'ItemList<Todo>',
    outputShape: 'ItemList<Todo>',
    dependsOn: [{ step: 'todos' }],
  });
  assert.throws(() => validatePipelineIr(ir), /mergePolicy is required/);
});

test('requires a merge policy for valid fan-in', () => {
  const ir = baseIr();
  ir.steps.push({ id: 'todos-copy', kind: 'transform.copy', inputShape: 'ItemList<Todo>', outputShape: 'ItemList<Todo>', dependsOn: [{ step: 'todos' }] });
  ir.steps.push({ id: 'merge', kind: 'transform.merge', inputShape: 'ItemList<Todo>', outputShape: 'ItemList<Todo>', mergePolicy: 'append', dependsOn: [{ step: 'todos' }, { step: 'todos-copy' }] });
  ir.expectedOutput = { fromStep: 'merge', shape: 'ItemList<Todo>', fields: [] };
  const result = validatePipelineIr(ir);
  assert.equal(result.steps.at(-1).id, 'merge');
});
