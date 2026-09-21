'use strict';

const assert = require('node:assert');
const { compileNodewiseSpecification } = require('../src/nodewiseCompiler');

console.log('--- Testing OVR-3 render_markdown Audit Regression Suite ---');

const baseSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_step_specification',
  goal: 'Test markdown renderer',
  requiredUserSetup: [],
  expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos'] },
  steps: [
    { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
    {
      id: 'fetch-todos',
      capability: 'http_request',
      requiredUserSetup: [],
      configuration: {
        method: 'GET',
        url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos', cardinality: 'items' },
      },
    },
    {
      id: 'render-step',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'render_markdown',
        input: { kind: 'prior_step', reference: 'fetch-todos.response', cardinality: 'items' },
        mode: 'markdownToHtml',
        field: 'title',
      },
    },
    {
      id: 'count',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'count_false_boolean',
        input: { kind: 'prior_step', reference: 'render-step.response', cardinality: 'items' },
        field: 'completed',
        totalField: 'totalTodos',
        falseCountField: 'incompleteTodos',
      },
    },
    {
      id: 'output',
      capability: 'set_output',
      requiredUserSetup: [],
      configuration: {
        input: { kind: 'prior_step', reference: 'count.response', cardinality: 'one_object' },
        mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }],
      },
    },
  ],
};

// 1. Test clean default when outputFieldName is completely omitted/undefined
const specDefault = JSON.parse(JSON.stringify(baseSpec));
const wfDefault = compileNodewiseSpecification(specDefault);
assert.strictEqual(wfDefault.nodes[2].parameters.destinationKey, 'renderedHtml');
assert.strictEqual(wfDefault.nodes[2].parameters.mode, 'markdownToHtml');
assert.strictEqual(wfDefault.nodes[2].parameters.markdown, '={{ $json.title }}');
assert.strictEqual(wfDefault.nodes[2].typeVersion, 1);
console.log('Test 1 (Omitted outputFieldName defaults safely): PASS');

// 2. Test explicit falsy outputFieldName fails closed (Must NOT silently default)
const falsyCases = ['', null, false, 0];
for (const falsyVal of falsyCases) {
  const badSpec = JSON.parse(JSON.stringify(baseSpec));
  badSpec.steps[2].configuration.outputFieldName = falsyVal;
  assert.throws(
    () => compileNodewiseSpecification(badSpec),
    /steps\[2\]\.configuration\.outputFieldName must be a simple field identifier/,
    `Expected falsy value ${JSON.stringify(falsyVal)} to fail closed with identifier assertion`
  );
}
console.log('Test 2 (Falsy outputFieldName fails closed): PASS');

// 3. Test explicit valid custom outputFieldName
const specCustom = JSON.parse(JSON.stringify(baseSpec));
specCustom.steps[2].configuration.outputFieldName = 'customHtmlOutput';
const wfCustom = compileNodewiseSpecification(specCustom);
assert.strictEqual(wfCustom.nodes[2].parameters.destinationKey, 'customHtmlOutput');
console.log('Test 3 (Explicit valid outputFieldName): PASS');

// 4. Test htmlToMarkdown mode defaults to renderedMarkdown
const specH2M = JSON.parse(JSON.stringify(baseSpec));
specH2M.steps[2].configuration.mode = 'htmlToMarkdown';
const wfH2M = compileNodewiseSpecification(specH2M);
assert.strictEqual(wfH2M.nodes[2].parameters.destinationKey, 'renderedMarkdown');
assert.strictEqual(wfH2M.nodes[2].parameters.mode, 'htmlToMarkdown');
assert.strictEqual(wfH2M.nodes[2].parameters.html, '={{ $json.title }}');
console.log('Test 4 (htmlToMarkdown defaults to renderedMarkdown): PASS');

// 5. Test outputFieldName collision with existing input field fails closed
const specCollision = JSON.parse(JSON.stringify(baseSpec));
specCollision.steps[2].configuration.outputFieldName = 'title'; // Collides with existing 'title' field
assert.throws(
  () => compileNodewiseSpecification(specCollision),
  /collides with an existing input field/,
  'Expected collision with input field to fail closed'
);
console.log('Test 5 (Output field collision fails closed): PASS');

console.log('ALL OVR-3 REPOSITORY REGRESSION TESTS PASS (100% verified)');
