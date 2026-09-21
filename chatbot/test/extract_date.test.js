'use strict';

const assert = require('node:assert');
const { compileNodewiseSpecification, validateSpecification } = require('../src/nodewiseCompiler');
const { getSkill } = require('../src/runtimeSkillRegistry');
const { defaultRegistry } = require('../src/catalogActionRegistry');
const { skillIdsForSpecification } = require('../src/approvedNodewiseCompiler');

console.log('--- Testing transform.extract_date (n8n-nodes-base.dateTime@2) In-Repo Suite ---');

const baseSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_step_specification',
  goal: 'Test extract date part',
  requiredUserSetup: [],
  expectedOutput: { deliveryShape: 'one_object', fields: ['totalItems'] },
  steps: [
    { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
    {
      id: 'fetch-data',
      capability: 'http_request',
      requiredUserSetup: [],
      configuration: {
        method: 'GET',
        url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos', cardinality: 'items' },
      },
    },
    {
      id: 'extract-step',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'extract_date',
        input: { kind: 'prior_step', reference: 'fetch-data.response', cardinality: 'items' },
        field: 'title',
        part: 'month',
        outputFieldName: 'extractedMonth',
      },
    },
    {
      id: 'count',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'count_false_boolean',
        input: { kind: 'prior_step', reference: 'extract-step.response', cardinality: 'items' },
        field: 'completed',
        totalField: 'totalItems',
        falseCountField: 'incompleteItems',
      },
    },
    {
      id: 'output',
      capability: 'set_output',
      requiredUserSetup: [],
      configuration: {
        input: { kind: 'prior_step', reference: 'count.response', cardinality: 'one_object' },
        mappings: [{ from: 'totalItems', to: 'totalItems', valueType: 'number' }],
      },
    },
  ],
};

// 1. Happy path per part value (all 7 allowed units)
const parts = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'];
for (const part of parts) {
  const partSpec = JSON.parse(JSON.stringify(baseSpec));
  partSpec.steps[2].configuration.part = part;
  partSpec.steps[2].configuration.outputFieldName = `extracted_${part}`;
  const wf = compileNodewiseSpecification(partSpec);
  const node = wf.nodes[2];
  assert.strictEqual(node.type, 'n8n-nodes-base.dateTime');
  assert.strictEqual(node.parameters.operation, 'extractDate');
  assert.strictEqual(node.parameters.date, '={{ $json.title }}');
  assert.strictEqual(node.parameters.part, part);
  assert.strictEqual(node.parameters.outputFieldName, `extracted_${part}`);
}
console.log('Test 1 (Happy path across all 7 parts: year/month/week/day/hour/minute/second): PASS');

// 2. Mandatory assertion: emitted typeVersion === 2
const wfDefault = compileNodewiseSpecification(baseSpec);
const extractNode = wfDefault.nodes[2];
assert.strictEqual(extractNode.typeVersion, 2, 'emitted typeVersion must be exactly 2');
console.log('Test 2 (Mandatory: emitted typeVersion is exactly 2): PASS');

// 3. Mandatory assertion: emitted includeInputFields === true
assert.deepStrictEqual(
  extractNode.parameters.options,
  { includeInputFields: true },
  'options.includeInputFields must be explicitly emitted as true'
);
console.log('Test 3 (Mandatory: options.includeInputFields === true strictly emitted): PASS');

// 4. Mandatory assertion: output field TYPE is number (source-verified from DateTimeV2.node.js:191)
// We test downstream join_object_and_count_false_boolean mapping:
// an objectMapping mapping extractedMonth to target with valueType 'number' succeeds,
// but with valueType 'string' fails closed.
const numConsumerSpec = JSON.parse(JSON.stringify(baseSpec));
numConsumerSpec.steps.splice(1, 0, {
  id: 'fetch-user',
  capability: 'http_request',
  requiredUserSetup: [],
  configuration: {
    method: 'GET',
    url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1', cardinality: 'one_object' },
  },
});
// Step 3 is extract-step. Replace Step 4 (count) with join_object_and_count_false_boolean
numConsumerSpec.steps[4] = {
  id: 'join-count',
  capability: 'data_transform',
  requiredUserSetup: [],
  configuration: {
    operation: 'join_object_and_count_false_boolean',
    objectInput: { kind: 'prior_step', reference: 'fetch-user.response', cardinality: 'one_object' },
    itemsInput: { kind: 'prior_step', reference: 'extract-step.response', cardinality: 'items' },
    objectMappings: [{ from: 'username', to: 'username', valueType: 'string' }],
    field: 'completed',
    totalField: 'totalItems',
    falseCountField: 'incompleteItems',
  },
};
numConsumerSpec.steps[5].configuration.input.reference = 'join-count.response';

// Downstream mapping expecting 'number' validates cleanly
const validJoinSpec = JSON.parse(JSON.stringify(numConsumerSpec));
validJoinSpec.steps[4].configuration.objectMappings.push({ from: 'extractedMonth', to: 'extractedMonth', valueType: 'number' });
// But wait, extractedMonth is on itemsInput, not objectInput!
// For itemsInput, join_object_and_count checks: assertInputField(itemsInput.output, field, expectedType: 'boolean')
// If we set field: 'extractedMonth' (which is number), it should fail requiring boolean:
const badFieldTypeSpec = JSON.parse(JSON.stringify(numConsumerSpec));
badFieldTypeSpec.steps[4].configuration.field = 'extractedMonth';

assert.throws(
  () => compileNodewiseSpecification(badFieldTypeSpec),
  /的型別是 number，但需要 boolean/,
  'Expected number type to be enforced on extractedMonth (rejecting boolean requirement)'
);
console.log('Test 4 (Mandatory: declared output field type is number, verified by schema assertion): PASS');

// 5. Part is required explicitly (omitting part rejects fail-closed)
const noPartSpec = JSON.parse(JSON.stringify(baseSpec));
delete noPartSpec.steps[2].configuration.part;
assert.throws(
  () => compileNodewiseSpecification(noPartSpec),
  /extract_date part must be one of:/,
  'Expected omitting part to fail closed'
);
console.log('Test 5 (Missing part fails closed): PASS');

// 6. Bad part rejects fail-closed
const badPartSpec = JSON.parse(JSON.stringify(baseSpec));
badPartSpec.steps[2].configuration.part = 'fortnight';
assert.throws(
  () => compileNodewiseSpecification(badPartSpec),
  /extract_date part must be one of:/,
  'Expected invalid part fortnight to fail closed'
);
console.log('Test 6 (Invalid part fails closed): PASS');

// 7. OutputFieldName collision with existing input field rejects fail-closed
const collisionSpec = JSON.parse(JSON.stringify(baseSpec));
collisionSpec.steps[2].configuration.outputFieldName = 'title'; // Already in input fields
assert.throws(
  () => compileNodewiseSpecification(collisionSpec),
  /collides with an existing input field/,
  'Expected outputFieldName collision to fail closed'
);
console.log('Test 7 (OutputFieldName collision fails closed): PASS');

// 8. Unknown/options property rejects fail-closed (options not planner reachable)
const unknownKeySpec = JSON.parse(JSON.stringify(baseSpec));
unknownKeySpec.steps[2].configuration.options = { includeInputFields: false };
assert.throws(
  () => compileNodewiseSpecification(unknownKeySpec),
  /has unsupported key options/,
  'Expected options property to fail closed'
);
console.log('Test 8 (options property fails closed / planner unreachable): PASS');

// 9. Wrong input field type (non-string field) rejects fail-closed
const wrongFieldTypeSpec = JSON.parse(JSON.stringify(baseSpec));
wrongFieldTypeSpec.steps[2].configuration.field = 'completed'; // boolean, not string
assert.throws(
  () => compileNodewiseSpecification(wrongFieldTypeSpec),
  /需要 string/,
  'Expected non-string input field to fail closed'
);
console.log('Test 9 (Non-string input field fails closed): PASS');

// 10. Non-items input cardinality rejects fail-closed
const nonItemsSpec = JSON.parse(JSON.stringify(baseSpec));
nonItemsSpec.steps.splice(1, 0, {
  id: 'fetch-user',
  capability: 'http_request',
  requiredUserSetup: [],
  configuration: {
    method: 'GET',
    url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1', cardinality: 'one_object' },
  },
});
nonItemsSpec.steps[3].configuration.input = { kind: 'prior_step', reference: 'fetch-user.response', cardinality: 'one_object' };
assert.throws(
  () => compileNodewiseSpecification(nonItemsSpec),
  /extract_date requires items input/,
  'Expected non-items input cardinality to fail closed'
);
console.log('Test 10 (Non-items input cardinality fails closed): PASS');

// 11. Deterministic compilation (byte-identical JSON across runs)
const run1 = JSON.stringify(compileNodewiseSpecification(baseSpec));
const run2 = JSON.stringify(compileNodewiseSpecification(baseSpec));
assert.strictEqual(run1, run2, 'Compilation output must be byte-identical');
console.log('Test 11 (Deterministic byte-identical compilation): PASS');

// 12. Registry and approval wiring verification
const skill = getSkill('transform.extract_date');
assert.strictEqual(skill.id, 'transform.extract_date');
assert.strictEqual(skill.compiler, 'nodewise');
assert.strictEqual(skill.requiresUserSetup, false);
assert.strictEqual(skill.risk, 'read_only');

const action = defaultRegistry.getAction('extract_date');
assert.strictEqual(action.cardId, 'extract_date');
assert.strictEqual(action.nodeType, 'n8n-nodes-base.dateTime');
assert.strictEqual(action.version, 2);

const skillIds = skillIdsForSpecification(baseSpec);
assert.ok(skillIds.includes('transform.extract_date'));
console.log('Test 12 (Registry, catalog, and approval wiring verified): PASS');

// 13. Falsy outputFieldName rejects fail-closed
const falsyCases = ['', null, false, 0];
for (const falsyVal of falsyCases) {
  const badSpec = JSON.parse(JSON.stringify(baseSpec));
  badSpec.steps[2].configuration.outputFieldName = falsyVal;
  assert.throws(
    () => compileNodewiseSpecification(badSpec),
    /steps\[2\]\.configuration\.outputFieldName must be a simple field identifier/,
    `Expected falsy outputFieldName ${JSON.stringify(falsyVal)} to fail closed`
  );
}
console.log('Test 13 (Falsy outputFieldName fails closed): PASS');

console.log('ALL transform.extract_date REPOSITORY REGRESSION TESTS PASS (100% verified)');
