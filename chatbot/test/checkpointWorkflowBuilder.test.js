'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');
const { verifyCandidateWorkflow } = require('../src/candidateWorkflowVerifier');
const {
  DEFAULT_TICKETS,
  CP2_RAW_TICKETS,
  NODE_KEYS,
  buildCheckpoint1ValidateWorkflow,
  deriveCheckpoint1Expected,
  assertCheckpoint1Artifact,
  buildCheckpoint2NormalizeWorkflow,
  deriveCheckpoint2Expected,
  assertCheckpoint2Artifact,
} = require('../src/checkpointWorkflowBuilder');

test('CP1 builds a deterministic three-node artifact from a literal requirement fixture', () => {
  const first = buildCheckpoint1ValidateWorkflow();
  const second = buildCheckpoint1ValidateWorkflow();

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assertCheckpoint1Artifact(first, { inputCount: DEFAULT_TICKETS.length });
  assert.equal(first.nodes.length, 3);
  assert.deepEqual(Object.keys(first.nodes[0]).sort(), [...NODE_KEYS].sort());
  assert.equal(first.nodes[0].type, 'n8n-nodes-base.manualTrigger');
  assert.equal(first.nodes[1].type, 'n8n-nodes-base.set');
  assert.equal(first.nodes[2].type, 'n8n-nodes-base.splitOut');
});

test('CP1 passes the shared structural and dataflow verifier', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'create',
    userRequest: 'Build the first validate checkpoint for a support-ticket workflow',
    candidateWorkflow: buildCheckpoint1ValidateWorkflow(),
  }, { runtimeSchemas });

  assert.equal(result.status, 'pass');
  assert.equal(result.verification.structural.status, 'pass');
  assert.equal(result.verification.dataflow.status, 'pass');
});

test('CP1 expected output is derived from the fixture rather than hand-counted', () => {
  const expected = deriveCheckpoint1Expected();
  assert.equal(expected.inputCount, 8);
  assert.equal(expected.outputCount, 8);
  assert.deepEqual(expected.fields, ['ticketId', 'priority', 'title']);
  assert.equal(expected.outputItems.filter((item) => item.ticketId === 'T1').length, 2);
});

test('CP2 builds a deterministic normalization checkpoint with an explicit raw fixture', () => {
  const first = buildCheckpoint2NormalizeWorkflow();
  const second = buildCheckpoint2NormalizeWorkflow();

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assertCheckpoint2Artifact(first, { inputCount: CP2_RAW_TICKETS.length });
  assert.equal(first.nodes.length, 4);
  assert.deepEqual(first.nodes.map((item) => item.type), [
    'n8n-nodes-base.manualTrigger',
    'n8n-nodes-base.set',
    'n8n-nodes-base.splitOut',
    'n8n-nodes-base.set',
  ]);
});

test('CP2 passes the shared structural and dataflow verifier', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'create',
    userRequest: 'Normalize raw support-ticket fields into the CP2 contract',
    candidateWorkflow: buildCheckpoint2NormalizeWorkflow(),
  }, { runtimeSchemas });

  assert.equal(result.status, 'pass');
  assert.equal(result.verification.structural.status, 'pass');
  assert.equal(result.verification.dataflow.status, 'pass');
});

test('CP2 derives the expected normalized field mapping from its fixture', () => {
  const expected = deriveCheckpoint2Expected();
  assert.equal(expected.inputCount, 8);
  assert.equal(expected.outputCount, 8);
  assert.deepEqual(expected.fields, ['ticketId', 'priority', 'title']);
  assert.deepEqual(expected.outputItems[0], { ticketId: 'T1', priority: 'high', title: 'Login fails' });
  assert.deepEqual(expected.outputItems[4], { ticketId: null, priority: 'high', title: 'No id' });
  assert.deepEqual(expected.outputItems[6], { ticketId: 'T7', priority: null, title: 'No priority' });
});

test('CP1 rejects malformed fixtures before producing an artifact', () => {
  assert.throws(
    () => buildCheckpoint1ValidateWorkflow({ tickets: [{ ticketId: 7, title: 'bad' }] }),
    /ticketId must be a string/
  );
  assert.throws(
    () => buildCheckpoint1ValidateWorkflow({ tickets: [] }),
    /non-empty array/
  );
});
