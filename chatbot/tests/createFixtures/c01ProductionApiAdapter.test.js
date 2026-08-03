'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { checksum, toProvisionWorkflow } = require('./c01FixtureIntegrity');
const { serializeProvisionReport } = require('./c01ExactIdFixtureProvisioner');
const { createProductionC01ProvisionAdapter } = require('./c01ProductionApiAdapter');
const { sanitizeCreateWorkflowPayload } = require('../../src/workflowCreatePayload');
const { main } = require('../runC01ProductionProvisionCli');

function configuredEnvironment(runtimeConfirmation = true) {
  return {
    N8N_BASE_URL: 'http://local.invalid',
    N8N_API_KEY: 'configured',
    ...(runtimeConfirmation ? { C01_PROVISION_ONE_SHOT_CONFIRMATION: 'C01_PROVISION_ONCE' } : {}),
  };
}

function response(status, body) {
  return { status, json: async () => body };
}

function workflowReadback(workflowId) {
  const workflow = { ...toProvisionWorkflow(), active: false };
  workflow.id = workflowId;
  return workflow;
}

test('both guards are required before CLI may issue any HTTP request', async () => {
  for (const { codeLevelProvisionEnabled, runtimeConfirmation } of [
    { codeLevelProvisionEnabled: false, runtimeConfirmation: false },
    { codeLevelProvisionEnabled: true, runtimeConfirmation: false },
    { codeLevelProvisionEnabled: false, runtimeConfirmation: true },
  ]) {
    let requests = 0;
    const result = await main({
      argv: [],
      environment: configuredEnvironment(runtimeConfirmation),
      codeLevelProvisionEnabled,
      fetchImpl: async () => { requests += 1; throw new Error('must-not-dispatch'); },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.integrity.category, 'adapter_unavailable');
    assert.equal(requests, 0);
  }
});

test('create body uses the shared Create sanitizer over the pinned C01 template and readback uses its exact create ID', async () => {
  const methods = [];
  const createdId = 'fixture-exact-id';
  const result = await main({
    argv: [],
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    fetchImpl: async (url, init) => {
      methods.push(init.method);
      if (init.method === 'POST') {
        assert.equal(checksum(JSON.parse(init.body)), checksum(sanitizeCreateWorkflowPayload(toProvisionWorkflow())));
        assert.equal(Object.keys(init).sort().join(','), 'body,headers,method');
        return response(201, { id: createdId });
      }
      assert.equal(init.method, 'GET');
      assert.equal(new URL(url).pathname.endsWith(`/${createdId}`), true);
      return response(200, workflowReadback(createdId));
    },
  });
  assert.equal(result.status, 'pass');
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(result.cleanup.eligible, false);
});

test('adapter permits one create and one matching exact readback only', async () => {
  let requests = 0;
  const exactId = 'fixture-exact-id';
  const adapter = createProductionC01ProvisionAdapter({
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    runtimeOneShotConfirmed: true,
    fetchImpl: async (_url, init) => {
      requests += 1;
      return init.method === 'POST'
        ? response(201, { id: exactId })
        : response(200, workflowReadback(exactId));
    },
  });
  const receipt = await adapter.createCanonicalC01();
  assert.equal(receipt.workflowId, exactId);
  await assert.rejects(adapter.readExactWorkflow('different-id'));
  assert.equal(requests, 1);
  await adapter.readExactWorkflow(exactId);
  assert.equal(requests, 2);
  await assert.rejects(adapter.createCanonicalC01());
  await assert.rejects(adapter.readExactWorkflow(exactId));
  assert.equal(requests, 2);
});

test('HTTP failure and response identity mismatch stop safely without response disclosure', async () => {
  const createHttpFailure = await main({
    argv: [],
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    fetchImpl: async () => response(500, { marker: 'private-test-marker' }),
  });
  assert.equal(createHttpFailure.status, 'fail');
  assert.equal(createHttpFailure.integrity.category, 'creation_unavailable');

  const identityMismatch = await main({
    argv: [],
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    fetchImpl: async (_url, init) => init.method === 'POST'
      ? response(201, { id: 'fixture-exact-id' })
      : response(200, workflowReadback('different-id')),
  });
  assert.equal(identityMismatch.status, 'fail');
  assert.equal(identityMismatch.integrity.category, 'readback_identity_mismatch');
});

test('serialized CLI report excludes runtime configuration, IDs, request data, and response markers', async () => {
  const result = await main({
    argv: [],
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    fetchImpl: async (_url, init) => init.method === 'POST'
      ? response(201, { id: 'fixture-exact-id', marker: 'private-test-marker' })
      : response(200, workflowReadback('fixture-exact-id')),
  });
  const stdout = serializeProvisionReport(result);
  for (const prohibited of ['fixture-exact-id', 'private-test-marker', 'configured', 'local.invalid', 'jsonplaceholder']) {
    assert.equal(stdout.includes(prohibited), false);
  }
  assert.equal(result.cleanup.eligible, false);
});

function receiptResponse({ status = 201, contentType = 'application/json', bodyReadable = true, value, jsonFails = false } = {}) {
  return {
    status,
    body: bodyReadable ? {} : null,
    headers: { get: () => contentType },
    json: async () => {
      if (jsonFails) throw new Error('synthetic-json-failure');
      return value;
    },
  };
}

function safeTelemetry(result) {
  return {
    httpStatus: result.httpStatus,
    safeContentTypeCategory: result.safeContentTypeCategory,
    bodyReadable: result.bodyReadable,
    jsonParseStatus: result.jsonParseStatus,
    topLevelIdPresent: result.topLevelIdPresent,
    dataEnvelopeIdPresent: result.dataEnvelopeIdPresent,
    workflowEnvelopeIdPresent: result.workflowEnvelopeIdPresent,
    transportOrTimeout: result.transportOrTimeout,
  };
}

async function runReceiptCase(createResponse) {
  return main({
    argv: [],
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    fetchImpl: async (_url, init) => {
      if (init.method === 'POST') return createResponse;
      throw new Error('unexpected-readback');
    },
  });
}

test('2xx top-level receipt telemetry passes without exposing the receipt value', async () => {
  const marker = 'synthetic-receipt-marker';
  const result = await main({
    argv: [],
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    fetchImpl: async (_url, init) => init.method === 'POST'
      ? receiptResponse({ value: { id: marker } })
      : receiptResponse({ status: 200, value: workflowReadback(marker) }),
  });
  assert.equal(result.status, 'pass');
  assert.deepEqual(safeTelemetry(result), {
    httpStatus: 201, safeContentTypeCategory: 'json', bodyReadable: true, jsonParseStatus: 'pass',
    topLevelIdPresent: true, dataEnvelopeIdPresent: false, workflowEnvelopeIdPresent: false, transportOrTimeout: false,
  });
  assert.equal(serializeProvisionReport(result).includes(marker), false);
});

test('data/workflow envelope ID presence is diagnostic-only and never accepted as a receipt', async () => {
  for (const [value, expected] of [
    [{ data: { id: 'synthetic-data-marker' } }, { dataEnvelopeIdPresent: true, workflowEnvelopeIdPresent: false }],
    [{ workflow: { id: 'synthetic-workflow-marker' } }, { dataEnvelopeIdPresent: false, workflowEnvelopeIdPresent: true }],
  ]) {
    const result = await runReceiptCase(receiptResponse({ value }));
    assert.equal(result.status, 'fail');
    assert.equal(result.integrity.category, 'creation_unavailable');
    assert.deepEqual(safeTelemetry(result), {
      httpStatus: 201, safeContentTypeCategory: 'json', bodyReadable: true, jsonParseStatus: 'pass',
      topLevelIdPresent: false, dataEnvelopeIdPresent: expected.dataEnvelopeIdPresent,
      workflowEnvelopeIdPresent: expected.workflowEnvelopeIdPresent, transportOrTimeout: false,
    });
    assert.equal(serializeProvisionReport(result).includes('synthetic-'), false);
  }
});

test('non-2xx, non-JSON, JSON parse failure, transport, and unreadable body have distinct safe telemetry', async () => {
  const cases = [
    [receiptResponse({ status: 403, value: { marker: 'synthetic-rejected' } }), {
      httpStatus: 403, safeContentTypeCategory: 'json', bodyReadable: true, jsonParseStatus: 'not_attempted', transportOrTimeout: false,
    }],
    [receiptResponse({ contentType: 'text/plain', jsonFails: true }), {
      httpStatus: 201, safeContentTypeCategory: 'non_json', bodyReadable: true, jsonParseStatus: 'fail', transportOrTimeout: false,
    }],
    [receiptResponse({ contentType: 'application/json', jsonFails: true }), {
      httpStatus: 201, safeContentTypeCategory: 'json', bodyReadable: true, jsonParseStatus: 'fail', transportOrTimeout: false,
    }],
    [receiptResponse({ contentType: 'application/json', bodyReadable: false }), {
      httpStatus: 201, safeContentTypeCategory: 'json', bodyReadable: false, jsonParseStatus: 'not_attempted', transportOrTimeout: false,
    }],
  ];
  for (const [createResponse, expected] of cases) {
    const result = await runReceiptCase(createResponse);
    assert.equal(result.status, 'fail');
    assert.equal(result.integrity.category, 'creation_unavailable');
    assert.deepEqual(safeTelemetry(result), {
      ...expected,
      topLevelIdPresent: false, dataEnvelopeIdPresent: false, workflowEnvelopeIdPresent: false,
    });
  }
  const transport = await main({
    argv: [],
    environment: configuredEnvironment(),
    codeLevelProvisionEnabled: true,
    fetchImpl: async () => { throw new Error('synthetic-transport-failure'); },
  });
  assert.deepEqual(safeTelemetry(transport), {
    httpStatus: null, safeContentTypeCategory: 'unknown', bodyReadable: false, jsonParseStatus: 'not_attempted',
    topLevelIdPresent: false, dataEnvelopeIdPresent: false, workflowEnvelopeIdPresent: false, transportOrTimeout: true,
  });
  assert.equal(serializeProvisionReport(transport).includes('synthetic-transport-failure'), false);
});
