'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  C01_MANIFEST,
  C01_TEMPLATE,
  checksum,
  createIntegrityContract,
  templateCanonicalValue,
  toProvisionWorkflow,
  validateC01FixtureTemplate,
  verifyC01FixtureReadback,
} = require('./c01FixtureIntegrity');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseline() {
  const integrityContract = createIntegrityContract();
  return { integrityContract, workflow: { ...toProvisionWorkflow(), active: false } };
}

function node(workflow, name) {
  return workflow.nodes.find((candidate) => candidate.name === name);
}

test('C01 template is complete, inactive, provisionable, and matches its integrity contract', () => {
  const { integrityContract, workflow } = baseline();
  assert.equal(validateC01FixtureTemplate().status, 'pass');
  assert.ok(integrityContract?.templateChecksum);
  assert.ok(integrityContract?.manifestHash);
  assert.doesNotThrow(() => JSON.stringify(workflow));
  assert.deepEqual(verifyC01FixtureReadback({ workflow, integrityContract }), {
    status: 'pass',
    reason: 'c01_readback_matches_integrity_contract',
    summary: {
      caseId: 'C01', nodeCount: 3, connectionCount: 2, inactive: true,
      credentialsAbsent: true, finalOutputContract: true,
    },
  });
});

test('canonical template checksum ignores n8n server-generated metadata', () => {
  const variant = clone(C01_TEMPLATE);
  variant.workflow.id = 'server-generated-workflow-id';
  variant.workflow.versionId = 'server-generated-version';
  variant.workflow.meta = { instanceId: 'server-generated-meta' };
  variant.workflow.createdAt = 'server-generated-time';
  variant.workflow.updatedAt = 'server-generated-time';
  variant.workflow.executionData = { ignored: true };
  variant.workflow.nodes.forEach((candidate, index) => {
    candidate.id = `server-generated-node-${index}`;
  });
  assert.equal(checksum(templateCanonicalValue(variant)), checksum(templateCanonicalValue(C01_TEMPLATE)));
  assert.equal(validateC01FixtureTemplate({ template: variant }).status, 'pass');
});

test('parameter, connection, method, credential, active-state, and output mapping changes fail verification', () => {
  const { integrityContract, workflow } = baseline();
  const variants = [];

  const parameterChanged = clone(workflow);
  node(parameterChanged, 'c01_http_get').parameters.options = { response: { ignored: true } };
  variants.push(parameterChanged);

  const connectionChanged = clone(workflow);
  connectionChanged.connections.c01_http_get.main[0][0].index = 1;
  variants.push(connectionChanged);

  const methodChanged = clone(workflow);
  node(methodChanged, 'c01_http_get').parameters.method = 'POST';
  variants.push(methodChanged);

  const credentialChanged = clone(workflow);
  node(credentialChanged, 'c01_http_get').credentials = { httpHeaderAuth: { id: 'opaque-reference' } };
  variants.push(credentialChanged);

  const activeChanged = clone(workflow);
  activeChanged.active = true;
  variants.push(activeChanged);

  const outputChanged = clone(workflow);
  node(outputChanged, 'c01_final_output').parameters.assignments.assignments[1].value = '={{ $json.id }}';
  variants.push(outputChanged);

  for (const variant of variants) {
    const verification = verifyC01FixtureReadback({ workflow: variant, integrityContract });
    assert.equal(verification.status, 'fail');
    assert.notEqual(verification.reason, 'c01_readback_matches_integrity_contract');
  }
});

test('manifest hash mismatch fails even when the workflow still matches the template', () => {
  const { integrityContract, workflow } = baseline();
  const changedManifest = clone(C01_MANIFEST);
  changedManifest.userRequest = `${changedManifest.userRequest} `;
  const result = verifyC01FixtureReadback({
    workflow,
    manifest: changedManifest,
    integrityContract,
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.reason, 'manifest_hash_mismatch');
});

test('template rejects node types or capabilities outside the C01 allowlist', () => {
  const unknownNode = clone(C01_TEMPLATE);
  node(unknownNode.workflow, 'c01_http_get').type = 'n8n-nodes-base.webhook';
  const credentialCapability = clone(C01_TEMPLATE);
  node(credentialCapability.workflow, 'c01_http_get').credentials = { httpHeaderAuth: { id: 'opaque-reference' } };
  assert.equal(validateC01FixtureTemplate({ template: unknownNode }).status, 'fail');
  assert.equal(validateC01FixtureTemplate({ template: credentialCapability }).status, 'fail');
});

test('integrity contract is serializable and does not retain workflow or manifest content', () => {
  const serialized = JSON.stringify(createIntegrityContract());
  assert.doesNotMatch(serialized, /jsonplaceholder|c01_http_get|userRequest|opaque-reference/i);
  assert.doesNotThrow(() => JSON.stringify(createIntegrityContract()));
});
