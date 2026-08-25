'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  compileFixtureWorkflow,
  deterministicNodeId,
  verifyCompiledFixtureReadback,
} = require('./fixtureWorkflowCompiler');
const { sanitizeCreateWorkflowPayload } = require('./workflowCreatePayload');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function authoringTemplate() {
  return {
    workflow: {
      name: 'fixture',
      active: false,
      nodes: [
        { fixtureKey: 'start', name: 'Start', type: 'test.start', typeVersion: 1, position: [0, 0], parameters: {} },
        { fixtureKey: 'finish', name: 'Finish', type: 'test.finish', typeVersion: 1, position: [240, 0], parameters: { keep: true } },
      ],
      connections: { Start: { main: [[{ node: 'Finish', type: 'main', index: 0 }]] } },
      settings: { executionOrder: 'v1' },
    },
  };
}

function compile(overrides = {}) {
  return compileFixtureWorkflow({
    fixtureId: 'fixture-a', authoringTemplate: authoringTemplate(), manifest: { caseId: 'fixture-a' }, integrityContract: {}, ...overrides,
  });
}

test('compiler is repeatable and derives UUID-format node IDs from fixture identity', () => {
  const first = compile();
  const second = compile();
  assert.deepEqual(first, second);
  for (const node of first.payload.nodes) assert.match(node.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(deterministicNodeId('fixture-a', 'start'), deterministicNodeId('fixture-b', 'start'));
  assert.notEqual(deterministicNodeId('fixture-a', 'start'), deterministicNodeId('fixture-a', 'finish'));
});

test('compiler rejects missing or duplicate fixture keys', () => {
  const missing = authoringTemplate();
  delete missing.workflow.nodes[0].fixtureKey;
  assert.throws(() => compile({ authoringTemplate: missing }), { code: 'fixture_key_invalid' });
  const duplicate = authoringTemplate();
  duplicate.workflow.nodes[1].fixtureKey = duplicate.workflow.nodes[0].fixtureKey;
  assert.throws(() => compile({ authoringTemplate: duplicate }), { code: 'fixture_key_invalid' });
});

test('fixture keys are authoring-only and compiled payload preserves allowed workflow content', () => {
  const compiled = compile();
  assert.deepEqual(compiled.payload, sanitizeCreateWorkflowPayload(compiled.payload));
  for (const node of compiled.payload.nodes) assert.equal(Object.hasOwn(node, 'fixtureKey'), false);
  assert.equal(compiled.payload.nodes[1].parameters.keep, true);
  assert.deepEqual(compiled.payload.connections, authoringTemplate().workflow.connections);
  assert.deepEqual(compiled.payload.settings, authoringTemplate().workflow.settings);
});

test('readback verification ignores server metadata while enforcing deterministic IDs and compiled topology', () => {
  const compiled = compile();
  const readback = clone(compiled.readbackWorkflow);
  readback.id = 'server-only';
  readback.meta = { server: true };
  readback.nodes.forEach((node) => { node.meta = { server: true }; });
  assert.equal(verifyCompiledFixtureReadback({
    fixtureId: 'fixture-a', authoringTemplate: authoringTemplate(), manifest: { caseId: 'fixture-a' }, integrityContract: compiled.integrity, workflow: readback,
  }).status, 'pass');
  readback.nodes[0].id = deterministicNodeId('fixture-a', 'other');
  assert.equal(verifyCompiledFixtureReadback({
    fixtureId: 'fixture-a', authoringTemplate: authoringTemplate(), manifest: { caseId: 'fixture-a' }, integrityContract: compiled.integrity, workflow: readback,
  }).status, 'fail');
});

test('compiler module has no environment, network, URL, secret, or arbitrary workflow input interface', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtureWorkflowCompiler.js'), 'utf8');
  assert.doesNotMatch(source, /process\.|fetch\(|https?:\/\/|api[_-]?key|secret|readFile|writeFile/i);
});
