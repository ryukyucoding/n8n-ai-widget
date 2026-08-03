'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runExecutionVerification, verifyFixtureExecutionOutput } = require('./executionVerificationRunner');

const C01 = require('../tests/createFixtures/C01.json');
const C04 = require('../tests/createFixtures/C04.json');
const C07 = require('../tests/createFixtures/C07.json');

function fixtureWorkflow(manifest, id = 'fixture-workflow-1') {
  return {
    id,
    nodes: [
      { type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      ...manifest.allowedUrls.map((url) => ({ type: 'n8n-nodes-base.httpRequest', parameters: { url } })),
      { type: 'n8n-nodes-base.set', parameters: {} },
    ],
  };
}

function c01Wrapper(overrides = {}) {
  return [{
    json: { id: 1, title: 'fixture title', ...overrides },
    pairedItem: { item: 0 },
    id: 'outer-id-is-not-output',
  }];
}

async function run(manifest, overrides = {}) {
  return runExecutionVerification({
    manifest,
    workflowId: 'fixture-workflow-1',
    readback: async () => fixtureWorkflow(manifest),
    executionAdapter: async () => ({ executionOutput: c01Wrapper() }),
    ...overrides,
  });
}

test('C01 enters the injected adapter and reads n8n item.json output', async () => {
  let adapterCalls = 0;
  const result = await run(C01, {
    executionAdapter: async () => {
      adapterCalls += 1;
      return { executionOutput: c01Wrapper({ id: 1, title: 'fixture title' }) };
    },
  });
  assert.equal(adapterCalls, 1);
  assert.deepEqual(result, {
    caseId: 'C01',
    status: 'pass',
    cleanup: { eligible: true },
    assertion: { findingCount: 0, findingCategories: {} },
  });
});

test('outer wrapper properties are never used as output data', async () => {
  const result = await run(C01, {
    executionAdapter: async () => ({
      executionOutput: [{ id: 1, title: 'outer title', json: {}, pairedItem: { item: 0 } }],
    }),
  });
  assert.equal(result.status, 'fail');
    assert.equal(result.assertion.findingCategories.execution_result, result.assertion.findingCount);
  assert.doesNotMatch(JSON.stringify(result), /outer title/);
});

test('missing, type, and exact-equals C01 assertion failures are de-identified', async () => {
  const missing = await run(C01, { executionAdapter: async () => ({ executionOutput: [{ json: { id: 1 } }] }) });
  const type = await run(C01, { executionAdapter: async () => ({ executionOutput: c01Wrapper({ id: 'not-a-number' }) }) });
  const equalsManifest = { ...C01, executionAssertions: [...C01.executionAssertions, { path: 'id', equals: 2 }] };
  const equals = await run(equalsManifest, { executionAdapter: async () => ({ executionOutput: c01Wrapper({ id: 1 }) }) });
  for (const result of [missing, type, equals]) {
    assert.equal(result.status, 'fail');
        assert.ok(result.assertion.findingCount > 0);
    assert.deepEqual(result.assertion.findingCategories, { execution_result: result.assertion.findingCount });
  }
  assert.doesNotMatch(JSON.stringify(type), /not-a-number|fixture title|outer-id-is-not-output/);
});

test('adapter failure is a fail while cleanup remains eligible after confirmed readback', async () => {
  const result = await run(C01, { executionAdapter: async () => { throw new Error('do not retain adapter detail'); } });
  assert.deepEqual(result, {
    caseId: 'C01',
    status: 'fail',
    cleanup: { eligible: true },
    assertion: { findingCount: 0, findingCategories: {} },
  });
  assert.doesNotMatch(JSON.stringify(result), /adapter detail/);
});

test('C04 and C07 remain skipped and do not call the adapter or readback', async () => {
  for (const manifest of [C04, C07]) {
    let readbackCalls = 0;
    let adapterCalls = 0;
    const result = await run(manifest, {
      readback: async () => { readbackCalls += 1; return fixtureWorkflow(manifest); },
      executionAdapter: async () => { adapterCalls += 1; return { executionOutput: c01Wrapper() }; },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.cleanup.eligible, false);
    assert.equal(readbackCalls, 0, manifest.caseId);
    assert.equal(adapterCalls, 0, manifest.caseId);
  }
});

test('unsafe manifest or readback is skipped before adapter invocation', async () => {
  let adapterCalls = 0;
  const unsafeManifest = await run({ ...C01, allowedUrls: ['https://example.test/not-allowed'] }, {
    executionAdapter: async () => { adapterCalls += 1; return { executionOutput: c01Wrapper() }; },
  });
  const unsafeReadback = await run(C01, {
    readback: async () => ({ ...fixtureWorkflow(C01), id: 'different-id' }),
    executionAdapter: async () => { adapterCalls += 1; return { executionOutput: c01Wrapper() }; },
  });
  assert.equal(adapterCalls, 0);
  assert.equal(unsafeManifest.status, 'skipped');
  assert.equal(unsafeReadback.status, 'skipped');
  assert.equal(unsafeReadback.cleanup.eligible, false);
});

test('skipped output assertion is never promoted to pass and C07 may only be independently asserted', async () => {
  const skipped = await run(C01, { executionAdapter: async () => ({ executionOutput: { id: 1, title: 'not-a-wrapper' } }) });
  assert.deepEqual({ status: skipped.status, findingCount: skipped.assertion.findingCount }, { status: 'skipped', findingCount: 0 });
  assert.notEqual(skipped.status, 'pass');

  const direct = verifyFixtureExecutionOutput({ manifest: C07, executionOutput: [{ json: { name: 'fixture name', email: 'fixture-email@example.test', total_todos: 20, incomplete_todos: 9 } }] });
  assert.equal(direct.status, 'pass');
});

test('result is JSON-safe and excludes workflow IDs, outputs, URLs, prompts, and secrets', async () => {
  const result = await run(C01, {
    executionAdapter: async () => ({ executionOutput: [{ json: { id: 'wrong', title: 'fixture title', email: 'fixture-email.test', token: 'secret-value-should-not-leak' } }] }),
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.status, 'fail');
  assert.doesNotMatch(serialized, /fixture-workflow-1|fixture-email\.test|secret-value-should-not-leak|fixture title|jsonplaceholder|userRequest/i);
  assert.doesNotThrow(() => JSON.stringify(result));
});
