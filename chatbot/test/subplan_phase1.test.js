'use strict';

const assert = require('node:assert');
const { compileNodewiseSpecification } = require('../src/nodewiseCompiler');
const { validateSubplanSpecification, compileSubplanSpecification } = require('../src/subplanCompiler');

console.log('--- Testing nodewise_subplan_specification Phase 1 Suite ---');

const baseFlatSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_step_specification',
  goal: 'Fetch todos, count incomplete, and set output',
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
      id: 'count',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'count_false_boolean',
        input: { kind: 'prior_step', reference: 'fetch-todos.response', cardinality: 'items' },
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

const subplanPhase1Spec = {
  schemaVersion: '1.0',
  kind: 'nodewise_subplan_specification',
  goal: 'Fetch todos, count incomplete, and set output',
  blocks: [
    {
      id: 'block-1',
      goal: 'Execute todo counting workflow block',
      input: {
        cardinality: 'one_object',
        fields: {},
      },
      output: {
        cardinality: 'one_object',
        fields: {
          totalTodos: 'number',
        },
      },
      checkpoint: true,
      steps: JSON.parse(JSON.stringify(baseFlatSpec.steps)),
    },
  ],
  composition: [],
  expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos'] },
};

// 1. Exact byte-identical output comparison between subplan compiler and flat compiler
const flatCompiled = compileNodewiseSpecification(baseFlatSpec);
const subplanCompiled = compileSubplanSpecification(subplanPhase1Spec);

const flatJson = JSON.stringify(flatCompiled);
const subplanJson = JSON.stringify(subplanCompiled);

assert.strictEqual(subplanJson, flatJson, 'Subplan Phase 1 output must be byte-identical to flat compiler output');
console.log('Test 1 (Byte-identical workflow emission between Phase 1 subplan and flat compiler): PASS');

// 2. Inert checkpoint property: true vs false vs omitted produces byte-identical output
const noCheckpointSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
delete noCheckpointSpec.blocks[0].checkpoint;
const falseCheckpointSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
falseCheckpointSpec.blocks[0].checkpoint = false;

const noCpCompiled = compileSubplanSpecification(noCheckpointSpec);
const falseCpCompiled = compileSubplanSpecification(falseCheckpointSpec);

assert.strictEqual(JSON.stringify(noCpCompiled), flatJson);
assert.strictEqual(JSON.stringify(falseCpCompiled), flatJson);
console.log('Test 2 (Inert checkpoint flag preserves byte-identical emission): PASS');

// 3. Reject invalid kind fail-closed
const badKindSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
badKindSpec.kind = 'invalid_subplan_kind';
assert.throws(
  () => validateSubplanSpecification(badKindSpec),
  /kind must be nodewise_subplan_specification/,
  'Expected invalid kind to fail closed'
);
console.log('Test 3 (Invalid kind fails closed): PASS');

// 4. Reject multi-block in Phase 1 fail-closed
const multiBlockSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
multiBlockSpec.blocks.push({
  id: 'block-2',
  goal: 'Second block',
  input: { cardinality: 'one_object', fields: {} },
  output: { cardinality: 'one_object', fields: {} },
  steps: [],
});
assert.throws(
  () => validateSubplanSpecification(multiBlockSpec),
  /Phase 1 subplan specification must contain exactly one block/,
  'Expected multi-block in Phase 1 to fail closed'
);
console.log('Test 4 (Multi-block in Phase 1 fails closed): PASS');

// 5. Reject non-empty composition in Phase 1 fail-closed
const nonEmtpyCompSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
nonEmtpyCompSpec.composition.push({ from: 'block-1', to: 'block-2' });
assert.throws(
  () => validateSubplanSpecification(nonEmtpyCompSpec),
  /Phase 1 composition must be empty/,
  'Expected non-empty composition in Phase 1 to fail closed'
);
console.log('Test 5 (Non-empty composition in Phase 1 fails closed): PASS');

// 6. Contract validation: invalid contract cardinality fails closed
const badContractSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
badContractSpec.blocks[0].input.cardinality = 'stream_unknown';
assert.throws(
  () => validateSubplanSpecification(badContractSpec),
  /block\.input\.cardinality must be one_object or items/,
  'Expected bad contract cardinality to fail closed'
);
console.log('Test 6 (Bad contract cardinality fails closed): PASS');

// 7. Output contract mismatch with expectedOutput fails closed
// Block steps produce totalTodos (number), block.output declares totalTodos, but expectedOutput expects unproducedField
const mismatchOutputSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
delete mismatchOutputSpec.blocks[0].output.fields.totalTodos;
assert.throws(
  () => validateSubplanSpecification(mismatchOutputSpec),
  /block\.output missing declared expectedOutput field totalTodos/,
  'Expected missing expectedOutput field in block output to fail closed'
);
console.log('Test 7 (Output contract mismatch fails closed): PASS');

// 8. Block steps scope validation: block internal steps validation fails closed if step invalid
const badStepSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
badStepSpec.blocks[0].steps[2].configuration.field = 'nonexistentField';
assert.throws(
  () => compileSubplanSpecification(badStepSpec),
  /沒有宣告欄位 nonexistentField/,
  'Expected invalid step inside block to fail closed'
);
console.log('Test 8 (Block step scope validation fails closed): PASS');

// 9. Contract derivation: ghost field in block.output fails closed
const ghostFieldSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
ghostFieldSpec.blocks[0].output.fields.ghostField = 'string';
assert.throws(
  () => validateSubplanSpecification(ghostFieldSpec),
  /block\.output declared ghost field "ghostField" not produced by block tail step/,
  'Expected ghost field in block.output to fail closed'
);
console.log('Test 9 (Ghost field in block.output fails closed against derived tail output): PASS');

// 10. Contract derivation: wrong type in block.output fails closed (e.g. string vs number)
const wrongTypeSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
wrongTypeSpec.blocks[0].output.fields.totalTodos = 'string'; // actual derived is number
assert.throws(
  () => validateSubplanSpecification(wrongTypeSpec),
  /block\.output field "totalTodos" declared type string does not match derived type number/,
  'Expected wrong type in block.output to fail closed'
);
console.log('Test 10 (Wrong field type in block.output fails closed against derived tail output): PASS');

// 11. Contract derivation: cardinality mismatch between block.output and derived tail fails closed
const wrongCardSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
wrongCardSpec.blocks[0].output.cardinality = 'items'; // tail is set_output (one_object)
assert.throws(
  () => validateSubplanSpecification(wrongCardSpec),
  /block\.output cardinality items must match tail step cardinality one_object/,
  'Expected cardinality mismatch in block.output to fail closed'
);
console.log('Test 11 (Cardinality mismatch in block.output fails closed against derived tail output): PASS');

// 12. Contract derivation: phantom input contract on root block fails closed (Probe B)
const phantomInputSpec = JSON.parse(JSON.stringify(subplanPhase1Spec));
phantomInputSpec.blocks[0].input.fields = { phantomField: 'string' };
assert.throws(
  () => validateSubplanSpecification(phantomInputSpec),
  /block\.input declared phantom input field "phantomField" not consumed by block entry step/,
  'Expected phantom input fields on root block to fail closed'
);
console.log('Test 12 (Phantom input contract on root block fails closed against vacuous requirement): PASS');

// 13. Contract derivation: non-root block phantom input fails closed (Aegis Probe)
const nonRootPhantomSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_subplan_specification',
  goal: 'Non-root block test',
  blocks: [
    {
      id: 'fetch-block',
      goal: 'Fetch and count block without manual_trigger',
      input: {
        cardinality: 'one_object',
        fields: { totallyMadeUp: 'string' }, // phantom input
      },
      output: {
        cardinality: 'one_object',
        fields: { totalTodos: 'number' },
      },
      steps: [
        {
          id: 'fetch',
          capability: 'http_request',
          requiredUserSetup: [],
          configuration: {
            method: 'GET',
            url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos', cardinality: 'items' },
          },
        },
        {
          id: 'count',
          capability: 'data_transform',
          requiredUserSetup: [],
          configuration: {
            operation: 'count_false_boolean',
            input: { kind: 'prior_step', reference: 'fetch.response', cardinality: 'items' },
            field: 'completed',
            totalField: 'totalTodos',
            falseCountField: 'incompleteTodos',
          },
        },
        {
          id: 'out',
          capability: 'set_output',
          requiredUserSetup: [],
          configuration: {
            input: { kind: 'prior_step', reference: 'count.response', cardinality: 'one_object' },
            mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }],
          },
        },
      ],
    },
  ],
  composition: [],
  expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos'] },
};
assert.throws(
  () => validateSubplanSpecification(nonRootPhantomSpec),
  /block\.input declared phantom input field "totallyMadeUp" not consumed by block entry step/,
  'Expected non-root block phantom input to fail closed'
);
console.log('Test 13 (Non-root block phantom input fails closed): PASS');

// 14. Contract derivation: non-root block wrong input cardinality fails closed
const nonRootWrongCardSpec = JSON.parse(JSON.stringify(nonRootPhantomSpec));
nonRootWrongCardSpec.blocks[0].input = { cardinality: 'items', fields: {} };
assert.throws(
  () => validateSubplanSpecification(nonRootWrongCardSpec),
  /block\.input cardinality items must match required input cardinality one_object/,
  'Expected non-root block wrong input cardinality to fail closed'
);
console.log('Test 14 (Non-root block wrong input cardinality fails closed): PASS');

console.log('ALL nodewise_subplan_specification PHASE 1 TESTS PASS (100% verified)');
