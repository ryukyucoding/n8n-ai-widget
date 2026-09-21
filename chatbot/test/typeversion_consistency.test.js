'use strict';

const assert = require('node:assert');
const { compileNodewiseSpecification, resolveCard } = require('../src/nodewiseCompiler');
const { DECLARED_ACTIONS, getDeclaredAction } = require('../src/declaredActions');
const { defaultRegistry } = require('../src/catalogActionRegistry');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');

console.log('--- Testing typeVersion Consistency & Authoritative Enforcement Suite ---');

// 1. Test pure in-repo declared actions: exactly 17 capabilities, branch_if is 2.3, merge_append is 3.2
assert.strictEqual(DECLARED_ACTIONS.length, 17, 'Expected exactly 17 declared actions');
const branchIfAction = getDeclaredAction('data_branch', 'branch_if');
assert.strictEqual(branchIfAction.version, 2.3, 'branch_if must be declared as 2.3');

const mergeAppendAction = getDeclaredAction('data_merge', 'merge_append');
assert.strictEqual(mergeAppendAction.version, 3.2, 'merge_append must be declared as 3.2');
console.log('Test 1 (Declared actions catalog corrections branch_if 2.3 and merge_append 3.2): PASS');

// 2. Test fallback registry matches declared actions exactly
const registryBranchIf = defaultRegistry.getAction('branch_if');
assert.strictEqual(registryBranchIf.version, 2.3, 'registry branch_if must be 2.3');

const registryMergeAppend = defaultRegistry.getAction('merge_append');
assert.strictEqual(registryMergeAppend.version, 3.2, 'registry merge_append must be 3.2');
console.log('Test 2 (Fallback registry matches declared actions): PASS');

// 3. Test resolveCard: fails closed if declared version does not exist in catalog
assert.throws(
  () => resolveCard('n8n-nodes-base.if', 999),
  /runtime n8n-nodes-base\.if does not expose declared typeVersion 999/,
  'Expected nonexistent version to fail closed'
);
assert.throws(
  () => resolveCard('n8n-nodes-base.nonExistentNode', 1),
  /runtime does not expose n8n-nodes-base\.nonExistentNode/,
  'Expected nonexistent node to fail closed'
);
console.log('Test 3 (resolveCard fails closed on nonexistent version or node): PASS');

// 4. Test resolveCard succeeds and binds exact version for valid declared version
const resolvedIf = resolveCard('n8n-nodes-base.if', 2.3);
assert.strictEqual(resolvedIf.type, 'n8n-nodes-base.if');
assert.strictEqual(resolvedIf.typeVersion, 2.3);

const resolvedMerge = resolveCard('n8n-nodes-base.merge', 3.2);
assert.strictEqual(resolvedMerge.type, 'n8n-nodes-base.merge');
assert.strictEqual(resolvedMerge.typeVersion, 3.2);
console.log('Test 4 (resolveCard binds exact declared version): PASS');

// 5. Test compileNodewiseSpecification with branch_if emits typeVersion 2.3
const ifSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_step_specification',
  goal: 'Test if step',
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
      id: 'branch-step',
      capability: 'data_branch',
      requiredUserSetup: [],
      configuration: {
        operation: 'branch_if',
        input: { kind: 'prior_step', reference: 'fetch-todos.response', cardinality: 'items' },
        condition: { field: 'completed', operator: 'equals', value: true },
        branches: ['count-true', 'count-false'],
      },
    },
    {
      id: 'sort-true',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'sort_items',
        input: { kind: 'prior_step', reference: 'branch-step.response', cardinality: 'items' },
        field: 'title',
        order: 'ascending',
      },
    },
    {
      id: 'sort-false',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'sort_items',
        input: { kind: 'prior_step', reference: 'branch-step.response', cardinality: 'items' },
        field: 'title',
        order: 'descending',
      },
    },
    {
      id: 'merge-step',
      capability: 'data_merge',
      requiredUserSetup: [],
      configuration: {
        operation: 'merge_append',
        inputs: [
          { kind: 'prior_step', reference: 'sort-true.response', cardinality: 'items' },
          { kind: 'prior_step', reference: 'sort-false.response', cardinality: 'items' },
        ],
      },
    },
    {
      id: 'count',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'count_false_boolean',
        input: { kind: 'prior_step', reference: 'merge-step.response', cardinality: 'items' },
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

const wfIf = compileNodewiseSpecification(ifSpec);
const ifNode = wfIf.nodes.find((n) => n.type === 'n8n-nodes-base.if');
assert.ok(ifNode, 'ifNode must exist');
assert.strictEqual(ifNode.typeVersion, 2.3, 'emitted if node must have typeVersion 2.3');

const mergeNode = wfIf.nodes.find((n) => n.type === 'n8n-nodes-base.merge');
assert.ok(mergeNode, 'mergeNode must exist');
assert.strictEqual(mergeNode.typeVersion, 3.2, 'emitted merge node must have typeVersion 3.2');
console.log('Test 5 (Compiler emits exact declared versions for branch_if 2.3 and merge_append 3.2): PASS');

// 6. Test format_date emits declared typeVersion 2 (closing format_date latent defect)
const dateSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_step_specification',
  goal: 'Test date format',
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
      id: 'format-step',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'format_date',
        input: { kind: 'prior_step', reference: 'fetch-todos.response', cardinality: 'items' },
        field: 'title',
        outputFieldName: 'formattedDate',
        format: 'yyyy-MM-dd',
      },
    },
    {
      id: 'count',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'count_false_boolean',
        input: { kind: 'prior_step', reference: 'format-step.response', cardinality: 'items' },
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

const wfDate = compileNodewiseSpecification(dateSpec);
const dateNode = wfDate.nodes.find((n) => n.type === 'n8n-nodes-base.dateTime');
assert.ok(dateNode, 'dateTime node must exist');
assert.strictEqual(dateNode.typeVersion, 2, 'emitted dateTime node must have typeVersion 2');
console.log('Test 6 (Compiler emits exact declared typeVersion: 2 for format_date): PASS');

// 7. Verify all 17 capabilities in DECLARED_ACTIONS have matching schemas in runtime snapshot
for (const action of DECLARED_ACTIONS) {
  const nodeSchema = runtimeSchemas.nodeTypes?.[action.nodeType];
  assert(nodeSchema, `Snapshot must expose ${action.nodeType} for ${action.cardId}`);
  const versionStr = String(action.version);
  assert(
    nodeSchema.versions?.[versionStr],
    `Snapshot ${action.nodeType} must expose version ${action.version} for ${action.cardId}`
  );
}
console.log('Test 7 (All 17 declared actions exist in runtime snapshot at exact declared versions): PASS');

console.log('ALL TYPEVERSION CONSISTENCY AND AUTHORITATIVE ENFORCEMENT TESTS PASS (100% verified)');
