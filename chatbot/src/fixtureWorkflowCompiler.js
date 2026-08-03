'use strict';

const crypto = require('node:crypto');
const { sanitizeCreateWorkflowPayload } = require('./workflowCreatePayload');

const ALLOWED_NODE_KEYS = new Set([
  'id', 'name', 'type', 'typeVersion', 'position', 'parameters', 'credentials',
  'disabled', 'notes', 'notesInFlow', 'onError', 'continueOnFail', 'retryOnFail',
  'maxTries', 'waitBetweenTries', 'alwaysOutputData', 'executeOnce', 'webhookId',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function checksum(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function invalid(reason) {
  const error = new Error(reason);
  error.code = reason;
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function deterministicNodeId(fixtureId, fixtureKey) {
  const fixture = nonEmptyString(fixtureId);
  const key = nonEmptyString(fixtureKey);
  if (!fixture || !key) throw invalid('fixture_id_or_key_invalid');
  const hash = crypto.createHash('sha256').update(`fixture-node:${fixture}:${key}`).digest('hex');
  const versioned = `${hash.slice(0, 12)}5${hash.slice(13, 16)}`;
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function nonEmptyCredentials(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function compileFixtureWorkflow({ fixtureId, authoringTemplate, manifest, integrityContract } = {}) {
  const normalizedFixtureId = nonEmptyString(fixtureId);
  if (!normalizedFixtureId) throw invalid('fixture_id_invalid');
  if (!isPlainObject(authoringTemplate) || !isPlainObject(authoringTemplate.workflow)) throw invalid('authoring_template_invalid');
  if (!isPlainObject(manifest) || !isPlainObject(integrityContract)) throw invalid('fixture_contract_invalid');

  const authoringWorkflow = authoringTemplate.workflow;
  if (authoringWorkflow.active !== false || !Array.isArray(authoringWorkflow.nodes)) throw invalid('authoring_workflow_invalid');
  const fixtureKeys = new Set();
  const nodeNames = new Set();
  const nodes = authoringWorkflow.nodes.map((authoringNode) => {
    if (!isPlainObject(authoringNode)) throw invalid('fixture_node_invalid');
    const fixtureKey = nonEmptyString(authoringNode.fixtureKey);
    if (!fixtureKey || fixtureKeys.has(fixtureKey)) throw invalid('fixture_key_invalid');
    fixtureKeys.add(fixtureKey);
    const nodeName = nonEmptyString(authoringNode.name);
    if (!nodeName || nodeNames.has(nodeName)) throw invalid('fixture_node_name_invalid');
    nodeNames.add(nodeName);
    if (nonEmptyCredentials(authoringNode.credentials)) throw invalid('fixture_credentials_not_allowed');
    const unknownKeys = Object.keys(authoringNode).filter((key) => key !== 'fixtureKey' && !ALLOWED_NODE_KEYS.has(key));
    if (unknownKeys.length) throw invalid('fixture_node_metadata_invalid');

    const compiledNode = { id: deterministicNodeId(normalizedFixtureId, fixtureKey) };
    for (const key of ALLOWED_NODE_KEYS) {
      if (key !== 'id' && key !== 'credentials' && authoringNode[key] !== undefined) compiledNode[key] = clone(authoringNode[key]);
    }
    return compiledNode;
  });

  const payload = sanitizeCreateWorkflowPayload({ ...authoringWorkflow, nodes });
  const authoringTemplateChecksum = checksum({ fixtureId: normalizedFixtureId, authoringTemplate, manifest });
  const compiledPayloadChecksum = checksum(payload);
  return {
    payload,
    readbackWorkflow: { ...clone(payload), active: false },
    integrity: {
      fixtureId: normalizedFixtureId,
      authoringTemplateChecksum,
      compiledPayloadChecksum,
      manifestChecksum: checksum(manifest),
    },
  };
}

function normalizeReadbackForCompiledPayload(workflow, compiledPayload) {
  if (!isPlainObject(workflow) || !isPlainObject(compiledPayload)) return null;
  if (workflow.active !== false || !Array.isArray(workflow.nodes) || !Array.isArray(compiledPayload.nodes)) return null;
  const expectedByName = new Map(compiledPayload.nodes.map((node) => [node.name, node]));
  if (expectedByName.size !== compiledPayload.nodes.length || workflow.nodes.length !== compiledPayload.nodes.length) return null;
  const actualByName = new Map();
  for (const actual of workflow.nodes) {
    if (!isPlainObject(actual) || nonEmptyCredentials(actual.credentials) || actualByName.has(actual.name)) return null;
    actualByName.set(actual.name, actual);
  }
  const nodes = [];
  for (const expected of compiledPayload.nodes) {
    const actual = actualByName.get(expected.name);
    if (!expected || actual.id !== expected.id) return null;
    const normalized = {};
    for (const key of Object.keys(expected)) normalized[key] = actual[key];
    nodes.push(normalized);
  }
  const normalized = { nodes };
  for (const key of Object.keys(compiledPayload)) {
    if (key !== 'nodes') normalized[key] = workflow[key];
  }
  return normalized;
}

function verifyCompiledFixtureReadback({ fixtureId, authoringTemplate, manifest, integrityContract, workflow } = {}) {
  let compiled;
  try {
    compiled = compileFixtureWorkflow({ fixtureId, authoringTemplate, manifest, integrityContract });
  } catch (error) {
    return { status: 'fail', reason: error.code || 'fixture_compile_failed' };
  }
  const expected = compiled.integrity;
  const contractManifestChecksum = integrityContract?.manifestChecksum || integrityContract?.compilerManifestChecksum;
  if (!isPlainObject(integrityContract)
    || integrityContract.authoringTemplateChecksum !== expected.authoringTemplateChecksum
    || integrityContract.compiledPayloadChecksum !== expected.compiledPayloadChecksum
    || contractManifestChecksum !== expected.manifestChecksum) {
    return { status: 'fail', reason: 'compiled_integrity_mismatch' };
  }
  const normalized = normalizeReadbackForCompiledPayload(workflow, compiled.payload);
  if (!normalized || checksum(normalized) !== expected.compiledPayloadChecksum) {
    return { status: 'fail', reason: 'compiled_readback_mismatch' };
  }
  return { status: 'pass', reason: 'compiled_readback_matches_integrity_contract' };
}

module.exports = {
  ALLOWED_NODE_KEYS,
  canonicalJson,
  checksum,
  compileFixtureWorkflow,
  deterministicNodeId,
  verifyCompiledFixtureReadback,
};
