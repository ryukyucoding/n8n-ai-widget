'use strict';

const REQUIRED_FORBIDDEN_CAPABILITIES = new Set([
  'credentials', 'webhook', 'schedule', 'email', 'slack', 'google', 'write',
]);
const SAFE_FIXTURE_NODE_TYPES = new Set([
  'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.set',
]);
const SANDBOX_ONLY_NODE_TYPES = new Set(['n8n-nodes-base.code']);
const ISOLATED_CODE_CAPABILITY = 'isolated_code_execution';
const DISALLOWED_NODE_TYPE = /(webhook|schedule|email|slack|google|write|mail)/i;
const SENSITIVE_KEY = /(credential|authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|oauth[_-]?secret|private[_-]?key|secret)/i;
const SECRET_VALUE = /^(?:sk-|pk_live_|ghp_|xox[baprs]-|bearer\s+)/i;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeJson(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSafeJson);
  return isPlainObject(value) && Object.entries(value).every(([key, nested]) => key !== '__proto__' && isSafeJson(nested));
}

function isAllowedFixtureUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'jsonplaceholder.typicode.com'
      && !url.port
      && !url.username
      && !url.password
      && !url.hash;
  } catch {
    return false;
  }
}

function hasSensitiveMaterial(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveMaterial);
  if (!isPlainObject(value)) return typeof value === 'string' && SECRET_VALUE.test(value.trim());
  return Object.entries(value).some(([key, nested]) => SENSITIVE_KEY.test(key)
    || hasSensitiveMaterial(nested));
}

function result(status, reason, manifest) {
  return {
    status,
    reason,
    report: {
      caseId: typeof manifest?.caseId === 'string' && /^C\d{2}(?![\s\S])/.test(manifest.caseId) ? manifest.caseId : null,
      safetyTier: ['controlled_fixture', 'sandbox_required'].includes(manifest?.safetyTier) ? manifest.safetyTier : null,
    },
  };
}

function validateSafeExecutionManifest(manifest) {
  if (!isPlainObject(manifest) || !isSafeJson(manifest)) return result('fail', 'invalid_manifest_shape', manifest);
  if (!['controlled_fixture', 'sandbox_required'].includes(manifest.safetyTier)) return result('fail', 'invalid_safety_tier', manifest);
  if (typeof manifest.caseId !== 'string' || !/^C\d{2}$/.test(manifest.caseId)) return result('fail', 'invalid_case_id', manifest);
  if (typeof manifest.userRequest !== 'string' || !manifest.userRequest.trim()) return result('fail', 'missing_user_request', manifest);
  if (manifest.expectedDeliveryState !== 'ready-to-run') return result('fail', 'invalid_expected_delivery_state', manifest);
  if (manifest.exactIdCleanupRequired !== true) return result('fail', 'exact_id_cleanup_required', manifest);
  if (!Array.isArray(manifest.allowedNodeTypes) || !manifest.allowedNodeTypes.length
    || manifest.allowedNodeTypes.some((type) => typeof type !== 'string'
      || (!SAFE_FIXTURE_NODE_TYPES.has(type) && !SANDBOX_ONLY_NODE_TYPES.has(type))
      || (type !== 'n8n-nodes-base.code' && DISALLOWED_NODE_TYPE.test(type)))) {
    return result('fail', 'unsafe_allowed_node_types', manifest);
  }
  if (!Array.isArray(manifest.allowedUrls) || !manifest.allowedUrls.length
    || manifest.allowedUrls.some((url) => !isAllowedFixtureUrl(url))) {
    return result('fail', 'unsafe_allowed_urls', manifest);
  }
  const forbidden = Array.isArray(manifest.forbiddenCapabilities)
    ? new Set(manifest.forbiddenCapabilities.filter((value) => typeof value === 'string').map((value) => value.toLowerCase()))
    : new Set();
  if ([...REQUIRED_FORBIDDEN_CAPABILITIES].some((capability) => !forbidden.has(capability))) {
    return result('fail', 'missing_forbidden_capability', manifest);
  }
  if (!Array.isArray(manifest.executionAssertions) || !manifest.executionAssertions.length) {
    return result('fail', 'missing_execution_assertions', manifest);
  }
  if (hasSensitiveMaterial({ ...manifest, userRequest: undefined, executionAssertions: undefined, forbiddenCapabilities: undefined })) {
    return result('fail', 'sensitive_manifest_material', manifest);
  }
  const hasCodeNode = manifest.allowedNodeTypes.includes('n8n-nodes-base.code');
  const hasIsolatedCodeCapability = manifest.executionEnvironment?.requiredCapability === ISOLATED_CODE_CAPABILITY;
  if ((hasCodeNode && (manifest.safetyTier !== 'sandbox_required' || !hasIsolatedCodeCapability))
    || (manifest.safetyTier === 'sandbox_required' && (!hasCodeNode || !hasIsolatedCodeCapability))) {
    return result('fail', 'code_node_requires_isolated_execution_environment', manifest);
  }
  if (manifest.safetyTier === 'sandbox_required') {
    return result('skipped', 'code_node_requires_isolated_execution_environment', manifest);
  }
  return result('pass', 'controlled_fixture_manifest_valid', manifest);
}

function collectUrls(value, urls = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, urls));
    return urls;
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) urls.push(value);
    return urls;
  }
  Object.values(value).forEach((item) => collectUrls(item, urls));
  return urls;
}

function isGetOnlyHttpNode(node) {
  if (node.type !== 'n8n-nodes-base.httpRequest') return true;
  const method = node.parameters?.method;
  return method === undefined || (typeof method === 'string' && method.toUpperCase() === 'GET');
}

function verifyWorkflowReadback({ workflow, workflowId, manifest } = {}) {
  if (validateSafeExecutionManifest(manifest).status !== 'pass') return result('fail', 'invalid_safe_execution_manifest', manifest);
  if (typeof workflowId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) return result('fail', 'invalid_exact_workflow_id', manifest);
  if (!isPlainObject(workflow) || workflow.id !== workflowId || !Array.isArray(workflow.nodes)) {
    return result('fail', 'workflow_identity_not_confirmed', manifest);
  }
  if (workflow.nodes.some((node) => !isPlainObject(node)
    || typeof node.type !== 'string'
    || !manifest.allowedNodeTypes.includes(node.type)
    || DISALLOWED_NODE_TYPE.test(node.type)
    || !isGetOnlyHttpNode(node)
    || (own(node, 'credentials') && node.credentials && Object.keys(node.credentials).length))) {
    return result('fail', 'workflow_nodes_not_allowlisted', manifest);
  }
  const urls = collectUrls(workflow.nodes);
  const allowed = new Set(manifest.allowedUrls);
  if (!urls.length || urls.some((url) => !allowed.has(url)) || manifest.allowedUrls.some((url) => !urls.includes(url))) {
    return result('fail', 'workflow_urls_not_allowlisted', manifest);
  }
  return result('pass', 'workflow_readback_allowlisted', manifest);
}

module.exports = { validateSafeExecutionManifest, verifyWorkflowReadback };
