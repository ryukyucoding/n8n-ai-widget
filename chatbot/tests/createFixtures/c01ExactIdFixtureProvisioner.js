'use strict';

const C01_MANIFEST = require('./C01.json');
const C01_TEMPLATE = require('./C01.workflow.template.json');
const PINNED_C01_INTEGRITY = require('./C01.fixture.integrity.json');
const {
  createIntegrityContract,
  validateC01FixtureTemplate,
  verifyC01FixtureReadback,
} = require('./c01FixtureIntegrity');

const C01_HUMAN_UI_FIXTURE_PREFIX = C01_TEMPLATE.fixturePrefix;
const SAFE_INTEGRITY_CATEGORIES = new Set([
  'not_evaluated', 'fixture_preflight_unavailable', 'fixture_template_invalid',
  'pinned_integrity_mismatch', 'adapter_unavailable', 'creation_unavailable',
  'create_response_missing_exact_id', 'readback_unavailable', 'readback_identity_mismatch',
  'integrity_verified', 'invalid_fixture_template', 'manifest_hash_mismatch',
  'template_checksum_mismatch', 'unsafe_readback_shape', 'integrity_mismatch',
]);
const SAFE_CONTENT_TYPE_CATEGORIES = new Set(['json', 'non_json', 'missing', 'unknown']);
const SAFE_JSON_PARSE_STATUSES = new Set(['pass', 'fail', 'not_attempted']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalExactId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : null;
}

function safeIntegrityCategory(value) {
  return typeof value === 'string' && SAFE_INTEGRITY_CATEGORIES.has(value) ? value : 'integrity_mismatch';
}

function safeReceiptTelemetry(value) {
  return {
    httpStatus: Number.isInteger(value?.httpStatus) ? value.httpStatus : null,
    safeContentTypeCategory: SAFE_CONTENT_TYPE_CATEGORIES.has(value?.safeContentTypeCategory)
      ? value.safeContentTypeCategory : 'unknown',
    bodyReadable: value?.bodyReadable === true,
    jsonParseStatus: SAFE_JSON_PARSE_STATUSES.has(value?.jsonParseStatus)
      ? value.jsonParseStatus : 'not_attempted',
    topLevelIdPresent: value?.topLevelIdPresent === true,
    dataEnvelopeIdPresent: value?.dataEnvelopeIdPresent === true,
    workflowEnvelopeIdPresent: value?.workflowEnvelopeIdPresent === true,
    transportOrTimeout: value?.transportOrTimeout === true,
  };
}

function report({
  status,
  creationProvenance = false,
  integrityStatus = 'skipped',
  integrityCategory = 'not_evaluated',
  receiptTelemetry,
} = {}) {
  return {
    caseId: 'C01',
    status: status === 'pass' || status === 'fail' ? status : 'skipped',
    creationProvenance: creationProvenance === true,
    integrity: {
      status: integrityStatus === 'pass' || integrityStatus === 'fail' ? integrityStatus : 'skipped',
      category: safeIntegrityCategory(integrityCategory),
    },
    ...safeReceiptTelemetry(receiptTelemetry),
    humanUiNextStep: status === 'pass',
    cleanup: {
      eligible: false,
      category: 'human_owner_required',
    },
  };
}

/*
 * The pinned contract is deliberately separate from the mutable template and
 * manifest. It is a safe digest-only approval record: changes to either input
 * are rejected before a create adapter may be invoked.
 */
function validatePinnedC01Fixture({
  template = C01_TEMPLATE,
  manifest = C01_MANIFEST,
  pinnedIntegrityContract = PINNED_C01_INTEGRITY,
} = {}) {
  if (validateC01FixtureTemplate({ template, manifest }).status !== 'pass') {
    return { status: 'fail', category: 'fixture_template_invalid' };
  }
  const calculated = createIntegrityContract({ template, manifest });
  if (!isPlainObject(calculated) || !isPlainObject(pinnedIntegrityContract)
    || pinnedIntegrityContract.caseId !== 'C01'
    || pinnedIntegrityContract.templateChecksum !== calculated.templateChecksum
    || pinnedIntegrityContract.manifestHash !== calculated.manifestHash
    || pinnedIntegrityContract.authoringTemplateChecksum !== calculated.authoringTemplateChecksum
    || pinnedIntegrityContract.compiledPayloadChecksum !== calculated.compiledPayloadChecksum
    || pinnedIntegrityContract.compilerManifestChecksum !== calculated.compilerManifestChecksum) {
    return { status: 'fail', category: 'pinned_integrity_mismatch' };
  }
  return { status: 'pass', category: 'integrity_verified' };
}

/*
 * Both adapters are injected. createCanonicalC01 takes no input and may only
 * return a sanitized exact-ID receipt with safe receipt telemetry. readExactWorkflow
 * receives the single exact ID from that receipt; it must not list or search workflows.
 */
async function runC01ExactIdFixtureProvisioner({ createCanonicalC01, readExactWorkflow, fixturePreflight = validatePinnedC01Fixture } = {}) {
  let preflight;
  try {
    preflight = typeof fixturePreflight === 'function' ? fixturePreflight() : null;
  } catch {
    return report({ status: 'skipped', integrityStatus: 'fail', integrityCategory: 'fixture_preflight_unavailable' });
  }
  if (!isPlainObject(preflight) || preflight.status !== 'pass') {
    return report({ status: 'skipped', integrityStatus: 'fail', integrityCategory: preflight?.category || 'fixture_preflight_unavailable' });
  }
  if (typeof createCanonicalC01 !== 'function' || typeof readExactWorkflow !== 'function') {
    return report({ status: 'skipped', integrityStatus: 'skipped', integrityCategory: 'adapter_unavailable' });
  }

  let receipt;
  try {
    receipt = await createCanonicalC01();
  } catch (error) {
    return report({
      status: 'fail',
      integrityStatus: 'skipped',
      integrityCategory: 'creation_unavailable',
      receiptTelemetry: error?.receiptTelemetry,
    });
  }
  const receiptTelemetry = safeReceiptTelemetry(receipt?.receiptTelemetry);
  const exactWorkflowId = canonicalExactId(receipt?.workflowId);
  if (!exactWorkflowId) {
    return report({
      status: 'fail',
      integrityStatus: 'skipped',
      integrityCategory: 'create_response_missing_exact_id',
      receiptTelemetry,
    });
  }

  let workflow;
  try {
    workflow = await readExactWorkflow(exactWorkflowId);
  } catch {
    return report({
      status: 'fail',
      creationProvenance: true,
      integrityStatus: 'fail',
      integrityCategory: 'readback_unavailable',
      receiptTelemetry,
    });
  }
  if (!isPlainObject(workflow) || canonicalExactId(workflow.id) !== exactWorkflowId) {
    return report({
      status: 'fail',
      creationProvenance: true,
      integrityStatus: 'fail',
      integrityCategory: 'readback_identity_mismatch',
      receiptTelemetry,
    });
  }

  const integrity = verifyC01FixtureReadback({
    workflow,
    template: C01_TEMPLATE,
    manifest: C01_MANIFEST,
    integrityContract: PINNED_C01_INTEGRITY,
  });
  if (integrity.status !== 'pass') {
    return report({
      status: 'fail',
      creationProvenance: true,
      integrityStatus: 'fail',
      integrityCategory: integrity.reason,
      receiptTelemetry,
    });
  }
  return report({
    status: 'pass',
    creationProvenance: true,
    integrityStatus: 'pass',
    integrityCategory: 'integrity_verified',
    receiptTelemetry,
  });
}

function serializeProvisionReport(result) {
  return JSON.stringify(report({
    status: result?.status,
    creationProvenance: result?.creationProvenance,
    integrityStatus: result?.integrity?.status,
    integrityCategory: result?.integrity?.category,
    receiptTelemetry: result,
  }));
}

module.exports = {
  C01_HUMAN_UI_FIXTURE_PREFIX,
  PINNED_C01_INTEGRITY,
  canonicalExactId,
  runC01ExactIdFixtureProvisioner,
  safeReceiptTelemetry,
  serializeProvisionReport,
  validatePinnedC01Fixture,
};
