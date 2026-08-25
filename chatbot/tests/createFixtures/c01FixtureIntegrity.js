'use strict';

const crypto = require('node:crypto');
const C01_MANIFEST = require('./C01.json');
const C01_TEMPLATE = require('./C01.workflow.template.json');
const { validateSafeExecutionManifest } = require('../../src/safeExecutionPolicy');
const { compileFixtureWorkflow, verifyCompiledFixtureReadback } = require('../../src/fixtureWorkflowCompiler');

const EXPECTED_NODE_TYPES = {
  manual_trigger: 'n8n-nodes-base.manualTrigger',
  http_get: 'n8n-nodes-base.httpRequest',
  final_output: 'n8n-nodes-base.set',
};
const EXPECTED_NODE_VERSIONS = {
  manual_trigger: 1,
  http_get: 4.4,
  final_output: 3.4,
};
const SERVER_GENERATED_FIELDS = new Set([
  'id', 'versionId', 'meta', 'createdAt', 'updatedAt', 'executionData', 'data', 'staticData', 'tags',
]);

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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

function safeCredentials(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return { invalid: true };
  const keys = Object.keys(value).sort();
  return keys.length ? Object.fromEntries(keys.map((key) => [key, value[key]])) : null;
}

function keyMaps(template) {
  if (!isPlainObject(template?.nodeKeys)) return null;
  const keys = Object.keys(EXPECTED_NODE_TYPES);
  if (keys.some((key) => typeof template.nodeKeys[key] !== 'string' || !template.nodeKeys[key])) return null;
  const names = keys.map((key) => template.nodeKeys[key]);
  if (new Set(names).size !== names.length) return null;
  return {
    keyToName: Object.fromEntries(keys.map((key) => [key, template.nodeKeys[key]])),
    nameToKey: Object.fromEntries(keys.map((key) => [template.nodeKeys[key], key])),
  };
}

function normalizeConnections(connections, nameToKey) {
  if (!isPlainObject(connections)) return null;
  const entries = [];
  for (const [sourceName, ports] of Object.entries(connections)) {
    const sourceKey = nameToKey[sourceName];
    if (!sourceKey || !isPlainObject(ports)) return null;
    for (const [sourcePort, outputs] of Object.entries(ports)) {
      if (!Array.isArray(outputs)) return null;
      outputs.forEach((targets, sourceIndex) => {
        if (!Array.isArray(targets)) {
          entries.push(null);
          return;
        }
        targets.forEach((target) => {
          if (!isPlainObject(target) || typeof target.node !== 'string'
            || typeof target.type !== 'string' || !Number.isInteger(target.index)
            || !nameToKey[target.node]) {
            entries.push(null);
            return;
          }
          entries.push({
            sourceKey,
            sourcePort,
            sourceIndex,
            targetKey: nameToKey[target.node],
            targetPort: target.type,
            targetIndex: target.index,
          });
        });
      });
    }
  }
  return entries.includes(null) ? null : entries.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function normalizeWorkflow(workflow, template) {
  if (!isPlainObject(workflow) || !Array.isArray(workflow.nodes)) return null;
  const maps = keyMaps(template);
  if (!maps || typeof workflow.name !== 'string') return null;
  const nodes = [];
  for (const node of workflow.nodes) {
    if (!isPlainObject(node) || typeof node.name !== 'string' || !maps.nameToKey[node.name]
      || typeof node.type !== 'string' || typeof node.typeVersion !== 'number'
      || !isPlainObject(node.parameters)
      || !Array.isArray(node.position) || node.position.length !== 2
      || node.position.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) return null;
    nodes.push({
      fixtureKey: maps.nameToKey[node.name],
      type: node.type,
      typeVersion: node.typeVersion,
      parameters: node.parameters,
      position: node.position,
      credentials: safeCredentials(node.credentials),
    });
  }
  if (new Set(nodes.map((node) => node.fixtureKey)).size !== nodes.length) return null;
  const connections = normalizeConnections(workflow.connections, maps.nameToKey);
  if (!connections) return null;
  return {
    name: workflow.name,
    active: workflow.active,
    settings: isPlainObject(workflow.settings) ? workflow.settings : {},
    nodes: nodes.sort((left, right) => left.fixtureKey.localeCompare(right.fixtureKey)),
    connections,
  };
}

function templateCanonicalValue(template = C01_TEMPLATE) {
  const normalized = normalizeWorkflow(template?.workflow, template);
  if (!normalized) return null;
  return {
    fixtureVersion: template.fixtureVersion,
    caseId: template.caseId,
    fixturePrefix: template.fixturePrefix,
    finalOutputNode: template.finalOutputNode,
    workflow: normalized,
  };
}

function c01Summary() {
  return {
    caseId: 'C01',
    nodeCount: 3,
    connectionCount: 2,
    inactive: true,
    credentialsAbsent: true,
    finalOutputContract: true,
  };
}

function assignmentContract(template) {
  const maps = keyMaps(template);
  const finalName = maps?.keyToName.final_output;
  const finalNode = template?.workflow?.nodes?.find((node) => node?.name === finalName);
  const assignments = finalNode?.parameters?.assignments?.assignments;
  if (!Array.isArray(assignments) || assignments.length !== 2) return false;
  const actual = assignments.map((assignment) => ({
    name: assignment?.name,
    type: assignment?.type,
    value: assignment?.value,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return canonicalJson(actual) === canonicalJson([
    { name: 'id', type: 'number', value: '={{ $json.id }}' },
    { name: 'title', type: 'string', value: '={{ $json.title }}' },
  ]);
}

function templateViolations(template = C01_TEMPLATE, manifest = C01_MANIFEST, { requireFixtureKeys = true } = {}) {
  const violations = [];
  if (validateSafeExecutionManifest(manifest).status !== 'pass') violations.push('manifest_not_safe');
  if (!isPlainObject(template) || template.caseId !== 'C01' || template.fixtureVersion !== 1
    || typeof template.fixturePrefix !== 'string' || !template.fixturePrefix
    || template.finalOutputNode !== 'final_output') return violations.concat('invalid_template_identity');
  const maps = keyMaps(template);
  const normalized = normalizeWorkflow(template.workflow, template);
  if (!maps || !normalized) return violations.concat('invalid_template_shape');
  if (requireFixtureKeys && template.workflow.nodes.some((node) => node?.fixtureKey !== maps.nameToKey[node?.name])) {
    violations.push('fixture_key_mismatch');
  }
  if (normalized.name !== `${template.fixturePrefix}v1`) violations.push('fixture_name_mismatch');
  if (normalized.active !== false) violations.push('fixture_must_be_inactive');
  if (normalized.nodes.length !== 3) violations.push('node_count_mismatch');
  for (const key of Object.keys(EXPECTED_NODE_TYPES)) {
    const node = normalized.nodes.find((candidate) => candidate.fixtureKey === key);
    if (!node || node.type !== EXPECTED_NODE_TYPES[key] || node.typeVersion !== EXPECTED_NODE_VERSIONS[key]) {
      violations.push('node_type_or_version_mismatch');
    }
    if (node?.credentials !== null) violations.push('credentials_not_allowed');
  }
  const httpNode = normalized.nodes.find((node) => node.fixtureKey === 'http_get');
  if (httpNode?.parameters?.method !== 'GET') violations.push('http_method_not_get');
  if (httpNode?.parameters?.url !== manifest.allowedUrls?.[0]) violations.push('http_url_not_allowlisted');
  if (!assignmentContract(template)) violations.push('final_output_contract_mismatch');
  const expectedConnections = [
    { sourceKey: 'http_get', sourcePort: 'main', sourceIndex: 0, targetKey: 'final_output', targetPort: 'main', targetIndex: 0 },
    { sourceKey: 'manual_trigger', sourcePort: 'main', sourceIndex: 0, targetKey: 'http_get', targetPort: 'main', targetIndex: 0 },
  ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(normalized.connections) !== canonicalJson(expectedConnections)) violations.push('connection_topology_mismatch');
  return [...new Set(violations)].sort();
}

function validateC01FixtureTemplate({ template = C01_TEMPLATE, manifest = C01_MANIFEST } = {}) {
  const violations = templateViolations(template, manifest);
  return {
    status: violations.length ? 'fail' : 'pass',
    reason: violations.length ? violations[0] : 'c01_template_valid',
    summary: c01Summary(),
  };
}

function createIntegrityContract({ template = C01_TEMPLATE, manifest = C01_MANIFEST } = {}) {
  if (validateC01FixtureTemplate({ template, manifest }).status !== 'pass') return null;
  const canonical = templateCanonicalValue(template);
  const compiled = compileFixtureWorkflow({ fixtureId: 'C01', authoringTemplate: template, manifest, integrityContract: {} });
  return {
    caseId: 'C01',
    templateChecksum: checksum(canonical),
    manifestHash: checksum(manifest),
    authoringTemplateChecksum: compiled.integrity.authoringTemplateChecksum,
    compiledPayloadChecksum: compiled.integrity.compiledPayloadChecksum,
    compilerManifestChecksum: compiled.integrity.manifestChecksum,
  };
}

function verifyC01FixtureReadback({ workflow, template = C01_TEMPLATE, manifest = C01_MANIFEST, integrityContract } = {}) {
  if (validateC01FixtureTemplate({ template, manifest }).status !== 'pass') {
    return { status: 'fail', reason: 'invalid_fixture_template', summary: c01Summary() };
  }
  const expected = createIntegrityContract({ template, manifest });
  if (!isPlainObject(integrityContract)
    || integrityContract.caseId !== 'C01'
    || integrityContract.manifestHash !== expected.manifestHash) {
    return { status: 'fail', reason: 'manifest_hash_mismatch', summary: c01Summary() };
  }
  if (integrityContract.templateChecksum !== expected.templateChecksum) {
    return { status: 'fail', reason: 'template_checksum_mismatch', summary: c01Summary() };
  }
  if (integrityContract.authoringTemplateChecksum !== expected.authoringTemplateChecksum
    || integrityContract.compiledPayloadChecksum !== expected.compiledPayloadChecksum
    || integrityContract.compilerManifestChecksum !== expected.compilerManifestChecksum) {
    return { status: 'fail', reason: 'compiled_integrity_mismatch', summary: c01Summary() };
  }
  const compiledReadback = verifyCompiledFixtureReadback({
    fixtureId: 'C01', authoringTemplate: template, manifest, integrityContract, workflow,
  });
  if (compiledReadback.status !== 'pass') {
    return { status: 'fail', reason: compiledReadback.reason, summary: c01Summary() };
  }
  const normalized = normalizeWorkflow(workflow, template);
  if (!normalized) return { status: 'fail', reason: 'unsafe_readback_shape', summary: c01Summary() };
  const violations = templateViolations({ ...template, workflow }, manifest, { requireFixtureKeys: false });
  if (violations.length) return { status: 'fail', reason: violations[0], summary: c01Summary() };
  if (checksum({ ...templateCanonicalValue(template), workflow: normalized }) !== expected.templateChecksum) {
    return { status: 'fail', reason: 'template_checksum_mismatch', summary: c01Summary() };
  }
  return { status: 'pass', reason: 'c01_readback_matches_integrity_contract', summary: c01Summary() };
}

function toProvisionWorkflow(template = C01_TEMPLATE) {
  if (validateC01FixtureTemplate({ template }).status !== 'pass') return null;
  return compileFixtureWorkflow({ fixtureId: 'C01', authoringTemplate: template, manifest: C01_MANIFEST, integrityContract: {} }).payload;
}

module.exports = {
  C01_MANIFEST,
  C01_TEMPLATE,
  SERVER_GENERATED_FIELDS,
  canonicalJson,
  checksum,
  createIntegrityContract,
  templateCanonicalValue,
  toProvisionWorkflow,
  validateC01FixtureTemplate,
  verifyC01FixtureReadback,
};
