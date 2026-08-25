'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runHumanExecutionEvidence } = require('./humanExecutionEvidenceRunner');
const C01 = require('../tests/createFixtures/C01.json');
const C04 = require('../tests/createFixtures/C04.json');

function evidence(items, overrides = {}) {
  return {
    id: 'execution-1',
    workflowId: 'workflow-1',
    data: {
      resultData: {
        lastNodeExecuted: 'final-node-name-is-never-reported',
        runData: {
          'final-node-name-is-never-reported': [{ data: { main: [items] } }],
        },
      },
    },
    ...overrides,
  };
}

async function run(readExecution, overrides = {}) {
  return runHumanExecutionEvidence({
    manifest: C01,
    workflowId: 'workflow-1',
    executionId: 'execution-1',
    readExecution,
    ...overrides,
  });
}

test('C01 human UI evidence passes after exact execution identity verification', async () => {
  let receivedExecutionId = null;
  const result = await run(async (executionId) => {
    receivedExecutionId = executionId;
    return evidence([{ json: { id: 1, title: 'fixture title' }, pairedItem: { item: 0 } }]);
  });
  assert.equal(receivedExecutionId, 'execution-1');
  assert.deepEqual(result, {
    caseId: 'C01',
    status: 'pass',
    executionTrigger: 'human_ui',
    cleanup: { eligible: false },
    assertion: { findingCount: 0, findingCategories: {} },
  });
});

test('only C01 is eligible and C04 never calls the readback adapter', async () => {
  let calls = 0;
  const result = await runHumanExecutionEvidence({
    manifest: C04,
    workflowId: 'workflow-1',
    executionId: 'execution-1',
    readExecution: async () => { calls += 1; return evidence([]); },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(calls, 0);
});

test('execution workflow ID mismatch is skipped', async () => {
  const result = await run(async () => evidence([{ json: { id: 1, title: 'fixture title' } }], { workflowId: 'other-workflow' }));
  assert.equal(result.status, 'skipped');
  assert.equal(result.cleanup.eligible, false);
});

test('missing or unsafe readback is skipped', async () => {
  const missing = await run(async () => undefined);
  const unsafe = await run(async () => ({ id: 'execution-1', workflowId: 'workflow-1', data: { resultData: { runData: {} } } }));
  const rejected = await run(async () => { throw new Error('readback body must not escape'); });
  for (const result of [missing, unsafe, rejected]) assert.equal(result.status, 'skipped');
});

test('C01 assertion mismatch fails after verified evidence identity', async () => {
  const result = await run(async () => evidence([{ json: { id: 'wrong-kind', title: 'fixture title' } }]));
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.assertion.findingCategories, { execution_result: 1 });
});

test('wrapper outer properties are never treated as final output fields', async () => {
  const result = await run(async () => evidence([{ id: 1, title: 'outer-title', json: {}, pairedItem: { item: 0 } }]));
  assert.equal(result.status, 'fail');
  assert.equal(result.assertion.findingCategories.execution_result, result.assertion.findingCount);
  assert.doesNotMatch(JSON.stringify(result), /outer-title/);
});

test('human evidence report is JSON-safe and excludes IDs, workflow, URL, output, and secrets', async () => {
  const result = await run(async () => evidence([{
    json: {
      id: 'wrong-kind',
      title: 'raw-title-must-not-leak',
      email: 'fixture-email@example.test',
      token: 'secret-value-must-not-leak',
    },
  }]));
  const serialized = JSON.stringify(result);
  assert.equal(result.status, 'fail');
  assert.doesNotMatch(serialized, /workflow-1|execution-1|final-node-name|raw-title|fixture-email|secret-value|jsonplaceholder/i);
  assert.doesNotThrow(() => JSON.stringify(result));
});
