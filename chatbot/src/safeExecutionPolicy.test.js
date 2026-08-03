'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSafeExecutionManifest, verifyWorkflowReadback } = require('./safeExecutionPolicy');

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

test('C01 is controlled while C04 and C07 require an isolated Code-node environment', () => {
  const controlled = validateSafeExecutionManifest(C01);
  assert.deepEqual({ status: controlled.status, reason: controlled.reason }, {
    status: 'pass', reason: 'controlled_fixture_manifest_valid',
  });

  for (const manifest of [C04, C07]) {
    const result = validateSafeExecutionManifest(manifest);
    assert.deepEqual({ status: result.status, reason: result.reason }, {
      status: 'skipped', reason: 'code_node_requires_isolated_execution_environment',
    });
    assert.equal(result.report.caseId, manifest.caseId);
    assert.doesNotMatch(JSON.stringify(result), /userRequest|jsonplaceholder/i);
  }
});

test('rejects unsafe manifest tiers, node types, and URLs without echoing manifest data', () => {
  const unsafeTier = validateSafeExecutionManifest({ ...C01, safetyTier: 'uncontrolled' });
  assert.deepEqual({ status: unsafeTier.status, reason: unsafeTier.reason }, {
    status: 'fail', reason: 'invalid_safety_tier',
  });

  const unsafeNode = validateSafeExecutionManifest({ ...C01, allowedNodeTypes: [...C01.allowedNodeTypes, 'n8n-nodes-base.emailSend'] });
  assert.equal(unsafeNode.reason, 'unsafe_allowed_node_types');

  const unsafeCommand = validateSafeExecutionManifest({ ...C01, allowedNodeTypes: ['n8n-nodes-base.executeCommand'] });
  assert.equal(unsafeCommand.reason, 'unsafe_allowed_node_types');

  const codeWithoutSandbox = validateSafeExecutionManifest({ ...C01, allowedNodeTypes: [...C01.allowedNodeTypes, 'n8n-nodes-base.code'] });
  assert.equal(codeWithoutSandbox.reason, 'code_node_requires_isolated_execution_environment');

  const unsafeUrl = validateSafeExecutionManifest({ ...C01, allowedUrls: ['https://example.test/private?token=do-not-echo'] });
  assert.equal(unsafeUrl.reason, 'unsafe_allowed_urls');
  assert.doesNotMatch(JSON.stringify(unsafeUrl), /example\.test|do-not-echo/);
});

test('readback requires exact identity, allowlisted nodes, and every manifest URL', () => {
  const valid = verifyWorkflowReadback({ workflow: fixtureWorkflow(C01), workflowId: 'fixture-workflow-1', manifest: C01 });
  assert.equal(valid.status, 'pass');

  const wrongIdentity = verifyWorkflowReadback({ workflow: fixtureWorkflow(C01, 'different'), workflowId: 'fixture-workflow-1', manifest: C01 });
  assert.equal(wrongIdentity.reason, 'workflow_identity_not_confirmed');

  const unsafeUrl = fixtureWorkflow(C01);
  unsafeUrl.nodes[1].parameters.url = 'https://example.test/not-allowed';
  const rejected = verifyWorkflowReadback({ workflow: unsafeUrl, workflowId: 'fixture-workflow-1', manifest: C01 });
  assert.equal(rejected.reason, 'workflow_urls_not_allowlisted');

  const writeAttempt = fixtureWorkflow(C01);
  writeAttempt.nodes[1].parameters.method = 'POST';
  const writeRejected = verifyWorkflowReadback({ workflow: writeAttempt, workflowId: 'fixture-workflow-1', manifest: C01 });
  assert.equal(writeRejected.reason, 'workflow_nodes_not_allowlisted');

  const credentialAttempt = fixtureWorkflow(C01);
  credentialAttempt.nodes[1].credentials = { fixtureReference: 'not-a-credential-value' };
  const credentialRejected = verifyWorkflowReadback({ workflow: credentialAttempt, workflowId: 'fixture-workflow-1', manifest: C01 });
  assert.equal(credentialRejected.reason, 'workflow_nodes_not_allowlisted');
});
