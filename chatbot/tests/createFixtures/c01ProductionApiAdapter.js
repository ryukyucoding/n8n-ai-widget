'use strict';

const { toProvisionWorkflow } = require('./c01FixtureIntegrity');
const { validatePinnedC01Fixture } = require('./c01ExactIdFixtureProvisioner');
const { sanitizeCreateWorkflowPayload } = require('../../src/workflowCreatePayload');

function canonicalExactId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : null;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyEnvironmentValue(environment, key) {
  const value = environment?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function isRuntimeOneShotConfirmed(environment) {
  return environment?.C01_PROVISION_ONE_SHOT_CONFIRMATION === 'C01_PROVISION_ONCE';
}

function requestUrl(baseUrl, path) {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBaseUrl).toString();
}

function safeContentTypeCategory(response) {
  try {
    const contentType = response?.headers?.get?.('content-type');
    if (typeof contentType !== 'string' || !contentType.trim()) return 'missing';
    return /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i.test(contentType) ? 'json' : 'non_json';
  } catch {
    return 'unknown';
  }
}

function createReceiptTelemetry(overrides = {}) {
  return {
    httpStatus: Number.isInteger(overrides.httpStatus) ? overrides.httpStatus : null,
    safeContentTypeCategory: ['json', 'non_json', 'missing', 'unknown'].includes(overrides.safeContentTypeCategory)
      ? overrides.safeContentTypeCategory : 'unknown',
    bodyReadable: overrides.bodyReadable === true,
    jsonParseStatus: ['pass', 'fail', 'not_attempted'].includes(overrides.jsonParseStatus)
      ? overrides.jsonParseStatus : 'not_attempted',
    topLevelIdPresent: overrides.topLevelIdPresent === true,
    dataEnvelopeIdPresent: overrides.dataEnvelopeIdPresent === true,
    workflowEnvelopeIdPresent: overrides.workflowEnvelopeIdPresent === true,
    transportOrTimeout: overrides.transportOrTimeout === true,
  };
}

function receiptFailure(receiptTelemetry) {
  const error = new Error('create_receipt_unavailable');
  error.receiptTelemetry = createReceiptTelemetry(receiptTelemetry);
  return error;
}

async function parseCreateReceipt(response) {
  const telemetry = createReceiptTelemetry({
    httpStatus: response?.status,
    safeContentTypeCategory: safeContentTypeCategory(response),
    bodyReadable: typeof response?.json === 'function' && response.body !== null,
  });
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw receiptFailure(telemetry);
  }
  if (!telemetry.bodyReadable) throw receiptFailure(telemetry);

  let created;
  try {
    created = await response.json();
  } catch {
    throw receiptFailure({ ...telemetry, jsonParseStatus: 'fail' });
  }
  const object = isPlainObject(created);
  return {
    created,
    receiptTelemetry: createReceiptTelemetry({
      ...telemetry,
      jsonParseStatus: 'pass',
      topLevelIdPresent: object && own(created, 'id'),
      dataEnvelopeIdPresent: object && isPlainObject(created.data) && own(created.data, 'id'),
      workflowEnvelopeIdPresent: object && isPlainObject(created.workflow) && own(created.workflow, 'id'),
    }),
  };
}

/*
 * This adapter is inert until both guards are passed by a code-only caller and
 * the per-process runtime confirmation is present. It never exposes base URL,
 * API key, request payload, workflow ID, or response data in its return values.
 */
function createProductionC01ProvisionAdapter({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  codeLevelProvisionEnabled = false,
  runtimeOneShotConfirmed = isRuntimeOneShotConfirmed(environment),
} = {}) {
  const bothGuardsEnabled = codeLevelProvisionEnabled === true && runtimeOneShotConfirmed === true;
  let createAttemptConsumed = false;
  let createdWorkflowId = null;
  let readbackConsumed = false;

  function runtimeConfiguration() {
    const baseUrl = nonEmptyEnvironmentValue(environment, 'N8N_BASE_URL');
    const apiKey = nonEmptyEnvironmentValue(environment, 'N8N_API_KEY');
    if (!baseUrl || !apiKey || typeof fetchImpl !== 'function') throw new Error('runtime_configuration_unavailable');
    return { baseUrl, apiKey };
  }

  return {
    async createCanonicalC01() {
      if (!bothGuardsEnabled || createAttemptConsumed) throw new Error('provision_guard_not_enabled');
      createAttemptConsumed = true;
      if (validatePinnedC01Fixture().status !== 'pass') throw new Error('pinned_fixture_integrity_unavailable');
      const { baseUrl, apiKey } = runtimeConfiguration();
      let response;
      try {
        response = await fetchImpl(requestUrl(baseUrl, 'api/v1/workflows'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-N8N-API-KEY': apiKey,
          },
          body: JSON.stringify(sanitizeCreateWorkflowPayload(toProvisionWorkflow())),
        });
      } catch {
        throw receiptFailure({ transportOrTimeout: true });
      }
      const { created, receiptTelemetry } = await parseCreateReceipt(response);
      const exactWorkflowId = canonicalExactId(created?.id);
      if (!exactWorkflowId) throw receiptFailure(receiptTelemetry);
      createdWorkflowId = exactWorkflowId;
      return { workflowId: exactWorkflowId, receiptTelemetry };
    },

    async readExactWorkflow(workflowId) {
      const exactWorkflowId = canonicalExactId(workflowId);
      if (!bothGuardsEnabled || readbackConsumed || !createdWorkflowId || exactWorkflowId !== createdWorkflowId) {
        throw new Error('exact_readback_not_authorized');
      }
      readbackConsumed = true;
      const { baseUrl, apiKey } = runtimeConfiguration();
      const response = await fetchImpl(requestUrl(baseUrl, `api/v1/workflows/${encodeURIComponent(exactWorkflowId)}`), {
        method: 'GET',
        headers: { 'X-N8N-API-KEY': apiKey },
      });
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
        || typeof response.json !== 'function') {
        throw new Error('public_api_response_unavailable');
      }
      try {
        return await response.json();
      } catch {
        throw new Error('public_api_response_unavailable');
      }
    },
  };
}

module.exports = {
  canonicalExactId,
  createProductionC01ProvisionAdapter,
  createReceiptTelemetry,
  isRuntimeOneShotConfirmed,
};
