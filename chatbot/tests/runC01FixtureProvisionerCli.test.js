'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { main, parseCliArgs } = require('./runC01FixtureProvisionerCli');
const { toProvisionWorkflow } = require('./createFixtures/c01FixtureIntegrity');

function readbackWithExactId(workflowId) {
  const workflow = toProvisionWorkflow();
  workflow.id = workflowId;
  return workflow;
}

test('fixture provisioner CLI accepts no user-controlled identifiers or workflow inputs', () => {
  assert.deepEqual(parseCliArgs([]), {});
  for (const args of [
    ['--workflowId', 'private-test-marker'],
    ['--url', 'private-test-marker'],
    ['C07'],
    ['--node', 'private-test-marker'],
  ]) {
    assert.equal(parseCliArgs(args), null);
  }
});

test('CLI is adapter-injected and emits only a de-identified C01 report', async () => {
  const result = await main({
    argv: [],
    createCanonicalC01: async () => ({ workflowId: 'fixture-exact-id' }),
    readExactWorkflow: async (workflowId) => readbackWithExactId(workflowId),
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.humanUiNextStep, true);
  assert.equal(result.cleanup.eligible, false);
  const serialized = JSON.stringify(result);
  for (const prohibited of ['fixture-exact-id', 'jsonplaceholder', 'workflowId']) {
    assert.equal(serialized.includes(prohibited), false);
  }
});

test('direct CLI mode has no bound external adapter and therefore skips', async () => {
  const result = await main({ argv: [] });
  assert.equal(result.caseId, "C01");
  assert.equal(result.status, "skipped");
  assert.equal(result.creationProvenance, false);
  assert.deepEqual(result.integrity, { status: "skipped", category: "adapter_unavailable" });
  assert.equal(result.humanUiNextStep, false);
  assert.deepEqual(result.cleanup, { eligible: false, category: "human_owner_required" });
  assert.deepEqual({ httpStatus: result.httpStatus, safeContentTypeCategory: result.safeContentTypeCategory, bodyReadable: result.bodyReadable, jsonParseStatus: result.jsonParseStatus, topLevelIdPresent: result.topLevelIdPresent, dataEnvelopeIdPresent: result.dataEnvelopeIdPresent, workflowEnvelopeIdPresent: result.workflowEnvelopeIdPresent, transportOrTimeout: result.transportOrTimeout }, { httpStatus: null, safeContentTypeCategory: "unknown", bodyReadable: false, jsonParseStatus: "not_attempted", topLevelIdPresent: false, dataEnvelopeIdPresent: false, workflowEnvelopeIdPresent: false, transportOrTimeout: false });
});
