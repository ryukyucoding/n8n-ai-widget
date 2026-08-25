'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const C01_MANIFEST = require('./C01.json');
const C01_TEMPLATE = require('./C01.workflow.template.json');
const {
  C01_HUMAN_UI_FIXTURE_PREFIX,
  PINNED_C01_INTEGRITY,
  runC01ExactIdFixtureProvisioner,
  serializeProvisionReport,
  validatePinnedC01Fixture,
} = require('./c01ExactIdFixtureProvisioner');
const { toProvisionWorkflow } = require('./c01FixtureIntegrity');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readbackWithExactId(workflowId = 'fixture-exact-id') {
  const workflow = { ...toProvisionWorkflow(), active: false };
  workflow.id = workflowId;
  return workflow;
}

function assertDefaultReceiptTelemetry(result) {
  assert.deepEqual({
    httpStatus: result.httpStatus,
    safeContentTypeCategory: result.safeContentTypeCategory,
    bodyReadable: result.bodyReadable,
    jsonParseStatus: result.jsonParseStatus,
    topLevelIdPresent: result.topLevelIdPresent,
    dataEnvelopeIdPresent: result.dataEnvelopeIdPresent,
    workflowEnvelopeIdPresent: result.workflowEnvelopeIdPresent,
    transportOrTimeout: result.transportOrTimeout,
  }, {
    httpStatus: null, safeContentTypeCategory: 'unknown', bodyReadable: false, jsonParseStatus: 'not_attempted',
    topLevelIdPresent: false, dataEnvelopeIdPresent: false, workflowEnvelopeIdPresent: false, transportOrTimeout: false,
  });
}

test('canonical C01 create receipt and one exact readback produce only a de-identified pass report', async () => {
  const calls = [];
  const result = await runC01ExactIdFixtureProvisioner({
    createCanonicalC01(...args) {
      calls.push({ operation: 'create', count: args.length });
      return { workflowId: 'fixture-exact-id' };
    },
    readExactWorkflow(...args) {
      calls.push({ operation: 'read', count: args.length, exact: args[0] });
      return readbackWithExactId(args[0]);
    },
  });

  assert.equal(result.caseId, "C01");
  assert.equal(result.status, "pass");
  assert.equal(result.creationProvenance, true);
  assert.deepEqual(result.integrity, { status: "pass", category: "integrity_verified" });
  assert.equal(result.humanUiNextStep, true);
  assert.deepEqual(result.cleanup, { eligible: false, category: "human_owner_required" });
  assertDefaultReceiptTelemetry(result);
  assert.deepEqual(calls.map(({ operation, count }) => ({ operation, count })), [
    { operation: 'create', count: 0 },
    { operation: 'read', count: 1 },
  ]);
  assert.equal(calls[1].exact, 'fixture-exact-id');
  assert.equal(Object.hasOwn(result, 'workflowId'), false);
  assert.equal(Object.hasOwn(result, 'workflow'), false);
  assert.equal(Object.hasOwn(result, 'cleanupRequested'), false);
  assert.equal(typeof C01_HUMAN_UI_FIXTURE_PREFIX, 'string');
  assert.ok(C01_HUMAN_UI_FIXTURE_PREFIX.length > 0);
});

test('missing exact ID and unavailable readback fail without another lookup or cleanup', async () => {
  let readCalls = 0;
  const missingId = await runC01ExactIdFixtureProvisioner({
    createCanonicalC01: async () => ({}),
    readExactWorkflow: async () => { readCalls += 1; },
  });
  assert.equal(missingId.status, 'fail');
  assert.equal(missingId.integrity.category, 'create_response_missing_exact_id');
  assert.equal(readCalls, 0);

  const readbackFailure = await runC01ExactIdFixtureProvisioner({
    createCanonicalC01: async () => ({ workflowId: 'fixture-exact-id' }),
    readExactWorkflow: async () => { throw new Error('do-not-disclose'); },
  });
  assert.equal(readbackFailure.status, 'fail');
  assert.equal(readbackFailure.creationProvenance, true);
  assert.equal(readbackFailure.integrity.category, 'readback_unavailable');
  assert.equal(readbackFailure.cleanup.eligible, false);
});

test('readback identity mismatch and integrity mismatch are distinct failures', async () => {
  const identityMismatch = await runC01ExactIdFixtureProvisioner({
    createCanonicalC01: async () => ({ workflowId: 'fixture-exact-id' }),
    readExactWorkflow: async () => readbackWithExactId('different-exact-id'),
  });
  assert.equal(identityMismatch.status, 'fail');
  assert.equal(identityMismatch.integrity.category, 'readback_identity_mismatch');

  const integrityMismatch = await runC01ExactIdFixtureProvisioner({
    createCanonicalC01: async () => ({ workflowId: 'fixture-exact-id' }),
    readExactWorkflow: async (id) => {
      const workflow = readbackWithExactId(id);
      workflow.active = true;
      return workflow;
    },
  });
  assert.equal(integrityMismatch.status, 'fail');
  assert.equal(integrityMismatch.integrity.status, 'fail');
  assert.notEqual(integrityMismatch.integrity.category, 'integrity_verified');
});

test('pinned fixture validation rejects changed template or manifest before create is called', async () => {
  const templateChanged = clone(C01_TEMPLATE);
  templateChanged.workflow.settings.executionOrder = 'v2';
  const manifestChanged = clone(C01_MANIFEST);
  manifestChanged.userRequest = `${manifestChanged.userRequest} `;
  assert.deepEqual(validatePinnedC01Fixture({ template: templateChanged }), {
    status: 'fail', category: 'pinned_integrity_mismatch',
  });
  assert.deepEqual(validatePinnedC01Fixture({ manifest: manifestChanged }), {
    status: 'fail', category: 'pinned_integrity_mismatch',
  });
  assert.equal(validatePinnedC01Fixture({ pinnedIntegrityContract: PINNED_C01_INTEGRITY }).status, 'pass');

  let createCalls = 0;
  const rejected = await runC01ExactIdFixtureProvisioner({
    createCanonicalC01: async () => { createCalls += 1; return { workflowId: 'fixture-exact-id' }; },
    readExactWorkflow: async () => readbackWithExactId(),
    fixturePreflight: () => validatePinnedC01Fixture({ manifest: manifestChanged }),
  });
  assert.equal(rejected.status, 'skipped');
  assert.equal(rejected.integrity.category, 'pinned_integrity_mismatch');
  assert.equal(createCalls, 0);
});

test('adapter interfaces expose no list/search path and report serialization retains no raw data', async () => {
  const rawOnlyInMemory = readbackWithExactId('fixture-exact-id');
  rawOnlyInMemory.nodes[1].credentials = { pretend: { marker: 'private-test-marker' } };
  const result = await runC01ExactIdFixtureProvisioner({
    createCanonicalC01: async () => ({ workflowId: 'fixture-exact-id' }),
    readExactWorkflow: async () => rawOnlyInMemory,
  });
  const stdout = serializeProvisionReport(result);
  const hostileSerialization = serializeProvisionReport({
    status: 'fail',
    creationProvenance: true,
    integrity: { status: 'fail', category: 'private-test-marker' },
    workflow: rawOnlyInMemory,
  });
  assert.equal(result.status, 'fail');
  assert.match(stdout, /^\{.*\}$/);
  for (const prohibited of ['fixture-exact-id', 'private-test-marker', 'jsonplaceholder']) {
    assert.equal(stdout.includes(prohibited), false);
    assert.equal(hostileSerialization.includes(prohibited), false);
  }
  assert.equal(Object.keys(result).some((key) => /list|search|latest/i.test(key)), false);
  assert.equal(result.cleanup.eligible, false);
});
