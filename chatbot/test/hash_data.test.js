'use strict';

const assert = require('node:assert');
const { compileNodewiseSpecification } = require('../src/nodewiseCompiler');

console.log('--- Testing Q10 hash_data (Crypto@1) In-Repo Regression Suite ---');

const baseSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_step_specification',
  goal: 'Test crypto hash data',
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
      id: 'hash-step',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'hash_data',
        input: { kind: 'prior_step', reference: 'fetch-todos.response', cardinality: 'items' },
        field: 'title',
        algorithm: 'SHA256',
        outputFieldName: 'titleHash',
        encoding: 'hex',
      },
    },
    {
      id: 'count',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'count_false_boolean',
        input: { kind: 'prior_step', reference: 'hash-step.response', cardinality: 'items' },
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

// 1. Test strictly pinned typeVersion: 1 and parameters
const wfDefault = compileNodewiseSpecification(baseSpec);
const cryptoNode = wfDefault.nodes[2];
assert.strictEqual(cryptoNode.type, 'n8n-nodes-base.crypto');
assert.strictEqual(cryptoNode.typeVersion, 1);
assert.strictEqual(cryptoNode.parameters.action, 'hash');
assert.strictEqual(cryptoNode.parameters.type, 'SHA256');
assert.strictEqual(cryptoNode.parameters.value, '={{ $json.title }}');
assert.strictEqual(cryptoNode.parameters.dataPropertyName, 'titleHash');
assert.strictEqual(cryptoNode.parameters.encoding, 'hex');
console.log('Test 1 (Pinned typeVersion: 1 and exact parameters): PASS');

// 2. Test algorithm vectors: MD5, SHA512, SHA384
const algorithms = ['MD5', 'SHA512', 'SHA384'];
for (const algo of algorithms) {
  const algoSpec = JSON.parse(JSON.stringify(baseSpec));
  algoSpec.steps[2].configuration.algorithm = algo;
  const wfAlgo = compileNodewiseSpecification(algoSpec);
  assert.strictEqual(wfAlgo.nodes[2].parameters.type, algo);
}
console.log('Test 2 (Algorithm vectors MD5/SHA512/SHA384): PASS');

// 3. Test encoding vectors: base64 vs hex
const b64Spec = JSON.parse(JSON.stringify(baseSpec));
b64Spec.steps[2].configuration.encoding = 'base64';
const wfB64 = compileNodewiseSpecification(b64Spec);
assert.strictEqual(wfB64.nodes[2].parameters.encoding, 'base64');
console.log('Test 3 (Encoding vector base64): PASS');

// 4. Test invalid algorithm rejected fail-closed
const badAlgoSpec = JSON.parse(JSON.stringify(baseSpec));
badAlgoSpec.steps[2].configuration.algorithm = 'UNSUPPORTED_ALGO_XYZ';
assert.throws(
  () => compileNodewiseSpecification(badAlgoSpec),
  /hash_data algorithm is unsupported/,
  'Expected unsupported algorithm to fail closed'
);
console.log('Test 4 (Unsupported algorithm fails closed): PASS');

// 5. Test invalid encoding rejected fail-closed
const badEncodingSpec = JSON.parse(JSON.stringify(baseSpec));
badEncodingSpec.steps[2].configuration.encoding = 'binary';
assert.throws(
  () => compileNodewiseSpecification(badEncodingSpec),
  /hash_data encoding must be hex or base64/,
  'Expected unsupported encoding to fail closed'
);
console.log('Test 5 (Unsupported encoding fails closed): PASS');

// 6. Test default outputFieldName if omitted
const noOutputFieldSpec = JSON.parse(JSON.stringify(baseSpec));
delete noOutputFieldSpec.steps[2].configuration.outputFieldName;
const wfNoOut = compileNodewiseSpecification(noOutputFieldSpec);
assert.strictEqual(wfNoOut.nodes[2].parameters.dataPropertyName, 'hashValue');
console.log('Test 6 (Default outputFieldName hashValue): PASS');

console.log('ALL Q10 HASH_DATA REPOSITORY REGRESSION TESTS PASS (100% verified)');
