'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWorkflowDataflowSummary,
  validateCodeDataflow,
  reconcileSemanticReview,
} = require('./workflowDataflow');

function workflow(nodes, connections) {
  return { nodes, connections };
}

function node(name, type, jsCode = undefined) {
  return {
    name,
    type,
    parameters: jsCode === undefined ? {} : { jsCode },
  };
}

function runtimeSchemas(definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([type, description]) => [type, {
    versions: { '1': description },
  }]));
}

function typedNode(name, type, jsCode = undefined) {
  return {
    ...node(name, type, jsCode),
    typeVersion: 1,
  };
}

const TEST_RUNTIME_SCHEMAS = runtimeSchemas({
  'test.source': { inputs: [] },
  'test.step': { inputs: ['main'] },
  'n8n-nodes-base.code': { inputs: ['main'] },
});


test('accepts reachable named Code references without direct connections', () => {
  const summary = buildWorkflowDataflowSummary(workflow([
    node('Manual Trigger', 'n8n-nodes-base.manualTrigger'),
    node('HTTP A', 'n8n-nodes-base.httpRequest'),
    node('HTTP B', 'n8n-nodes-base.httpRequest'),
    node('Process Data', 'n8n-nodes-base.code', "const a = $('HTTP A').first(); const b = $('HTTP B').all(); return [a, ...b];"),
  ], {
    'Manual Trigger': { main: [[{ node: 'HTTP A', type: 'main', index: 0 }]] },
    'HTTP A': { main: [[{ node: 'HTTP B', type: 'main', index: 0 }]] },
    'HTTP B': { main: [[{ node: 'Process Data', type: 'main', index: 0 }]] },
  }));

  assert.deepEqual(validateCodeDataflow(summary), []);
  assert.deepEqual(summary.codeNodeReferences.map(({ referencedNode, exists, reachableBeforeCode }) => ({
    referencedNode, exists, reachableBeforeCode,
  })), [
    { referencedNode: 'HTTP A', exists: true, reachableBeforeCode: true },
    { referencedNode: 'HTTP B', exists: true, reachableBeforeCode: true },
  ]);
});

test('rejects Code references to missing nodes', () => {
  const summary = buildWorkflowDataflowSummary(workflow([
    node('Manual Trigger', 'n8n-nodes-base.manualTrigger'),
    node('Process Data', 'n8n-nodes-base.code', "return [$('Missing Source').first()];"),
  ], {
    'Manual Trigger': { main: [[{ node: 'Process Data', type: 'main', index: 0 }]] },
  }));

  assert.deepEqual(validateCodeDataflow(summary), [
    "Code node 'Process Data' references missing node 'Missing Source'",
  ]);
});

test('rejects Code references to nodes that cannot reach the Code node', () => {
  const summary = buildWorkflowDataflowSummary(workflow([
    node('Manual Trigger', 'n8n-nodes-base.manualTrigger'),
    node('Parallel Source', 'n8n-nodes-base.httpRequest'),
    node('Process Data', 'n8n-nodes-base.code', "return [$('Parallel Source').all()];"),
  ], {
    'Manual Trigger': {
      main: [[
        { node: 'Parallel Source', type: 'main', index: 0 },
        { node: 'Process Data', type: 'main', index: 0 },
      ]],
    },
  }));

  assert.deepEqual(validateCodeDataflow(summary), [
    "Code node 'Process Data' references 'Parallel Source', which cannot reach it before execution",
  ]);
});

test('downgrades a semantic dataflow claim that conflicts with a valid reference', () => {
  const summary = buildWorkflowDataflowSummary(workflow([
    node('Manual Trigger', 'n8n-nodes-base.manualTrigger'),
    node('HTTP A', 'n8n-nodes-base.httpRequest'),
    node('Process Data', 'n8n-nodes-base.code', "return [$('HTTP A').first()];"),
  ], {
    'Manual Trigger': { main: [[{ node: 'HTTP A', type: 'main', index: 0 }]] },
    'HTTP A': { main: [[{ node: 'Process Data', type: 'main', index: 0 }]] },
  }));

  const result = reconcileSemanticReview({
    verdict: 'revise',
    repairInstruction: 'Add a direct data connection.',
    issues: [{
      message: 'HTTP A data does not reach Process Data.',
      evidence: {
        kind: 'code_dataflow',
        code_node: 'Process Data',
        referenced_node: 'HTTP A',
      },
    }],
  }, summary);

  assert.equal(result.verdict, 'pass');
  assert.equal(result.issues.length, 0);
  assert.equal(result.warnings.length, 1);
});

test('rejects sibling fan-out that joins an any-input node before named Code reads', () => {
  const summary = buildWorkflowDataflowSummary(workflow([
    typedNode('Start', 'test.source'),
    typedNode('Left', 'test.step'),
    typedNode('Right', 'test.step'),
    typedNode('Aggregate', 'n8n-nodes-base.code', "return [$('Left').all(), $('Right').all()];"),
  ], {
    Start: { main: [[{ node: 'Left', type: 'main', index: 0 }, { node: 'Right', type: 'main', index: 0 }]] },
    Left: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] },
    Right: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] },
  }), { runtimeSchemas: TEST_RUNTIME_SCHEMAS });

  assert.equal(summary.nodes.find((item) => item.name === 'Aggregate').executionContract.kind, 'any-input-trigger');
  assert.ok(summary.codeNodeReferences.every((item) => item.reachableBeforeCode && !item.mustExecuteBefore));
  assert.ok(validateCodeDataflow(summary).every((error) => error.includes('reachable but not guaranteed to execute')));
});

test('accepts named Code reads after a runtime-verified all-required-inputs barrier', () => {
  const schemas = { ...TEST_RUNTIME_SCHEMAS, ...runtimeSchemas({
    'test.barrier': {
      inputs: ['main', 'main'],
      executionContract: { kind: 'all-required-inputs-barrier', requiredInputIndices: [0, 1] },
    },
  }) };
  const summary = buildWorkflowDataflowSummary(workflow([
    typedNode('Start', 'test.source'),
    typedNode('Left', 'test.step'),
    typedNode('Right', 'test.step'),
    typedNode('Barrier', 'test.barrier'),
    typedNode('Aggregate', 'n8n-nodes-base.code', "return [$('Left').item(), $('Right').itemMatching(0)];"),
  ], {
    Start: { main: [[{ node: 'Left', type: 'main', index: 0 }, { node: 'Right', type: 'main', index: 0 }]] },
    Left: { main: [[{ node: 'Barrier', type: 'main', index: 0 }]] },
    Right: { main: [[{ node: 'Barrier', type: 'main', index: 1 }]] },
    Barrier: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] },
  }), { runtimeSchemas: schemas });

  assert.equal(summary.nodes.find((item) => item.name === 'Barrier').executionContract.kind, 'all-required-inputs-barrier');
  assert.deepEqual(validateCodeDataflow(summary), []);
});

test('rejects a multi-input join whose runtime execution semantics are unknown', () => {
  const schemas = { ...TEST_RUNTIME_SCHEMAS, ...runtimeSchemas({ 'test.unknown': { inputs: ['main', 'main'] } }) };
  const summary = buildWorkflowDataflowSummary(workflow([
    typedNode('Start', 'test.source'),
    typedNode('Left', 'test.step'),
    typedNode('Right', 'test.step'),
    typedNode('Join', 'test.unknown'),
    typedNode('Aggregate', 'n8n-nodes-base.code', "return [$('Left').first(), $('Right').all()];"),
  ], {
    Start: { main: [[{ node: 'Left', type: 'main', index: 0 }, { node: 'Right', type: 'main', index: 0 }]] },
    Left: { main: [[{ node: 'Join', type: 'main', index: 0 }]] },
    Right: { main: [[{ node: 'Join', type: 'main', index: 1 }]] },
    Join: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] },
  }), { runtimeSchemas: schemas });

  assert.equal(summary.nodes.find((item) => item.name === 'Join').executionContract.kind, 'unknown');
  assert.equal(validateCodeDataflow(summary).length, 2);
});

test('C07 regression: serial named upstream data remains valid', () => {
  const summary = buildWorkflowDataflowSummary(workflow([
    typedNode('Start', 'test.source'),
    typedNode('Get User', 'test.step'),
    typedNode('Get Items', 'test.step'),
    typedNode('Build Summary', 'n8n-nodes-base.code', "const user = $('Get User').first(); return [user];"),
  ], {
    Start: { main: [[{ node: 'Get User', type: 'main', index: 0 }]] },
    'Get User': { main: [[{ node: 'Get Items', type: 'main', index: 0 }]] },
    'Get Items': { main: [[{ node: 'Build Summary', type: 'main', index: 0 }]] },
  }), { runtimeSchemas: TEST_RUNTIME_SCHEMAS });

  assert.deepEqual(validateCodeDataflow(summary), []);
  assert.equal(summary.codeNodeReferences[0].mustExecuteBefore, true);
});
