'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCredentialPreviewHandler, registerCredentialPreviewRoute } = require('./conversationCredentialRoute');
const { createFakeCredentialResolver } = require('./conversationDeps');

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const allowedPolicy = {
  lane: 'solo', soloCredentialMode: true, runtimeCompilerEnabled: true,
  apiKeyPresent: true, privatePerimeterVerified: true,
};
const trustedDeploymentEnv = { PRIVATE_PERIMETER_VERIFIED: 'true' };

function fakeResolver(candidates = []) {
  return createFakeCredentialResolver({
    policy: allowedPolicy,
    requiredTypesForSpec: () => ['googleCalendarOAuth2Api'],
    listCandidates: async () => candidates,
    callerId: 'solo',
  });
}

test('live/public route behavior is disabled unless the fake-only seam is explicit', async () => {
  let called = 0;
  const handler = createCredentialPreviewHandler({
    policy: allowedPolicy, testSeamEnabled: false, fakeOnly: true,
    resolveCredentials: async () => { called += 1; return {}; },
  });
  const res = response();
  await handler({ body: { spec: {} } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'credential_test_seam_disabled');
  assert.equal(called, 0);
});

test('mode-off and perimeter-off reject before the fake resolver is called', async () => {
  for (const [policy, deploymentEnv] of [
    [{ ...allowedPolicy, soloCredentialMode: false }, trustedDeploymentEnv],
    [{ ...allowedPolicy, privatePerimeterVerified: true }, {}],
  ]) {
    let called = 0;
    const handler = createCredentialPreviewHandler({
      policy, deploymentEnv, testSeamEnabled: true, fakeOnly: true,
      resolveCredentials: async () => { called += 1; return {}; },
    });
    const res = response();
    await handler({ body: { spec: {} } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(called, 0);
  }
});

test('public lane remains rejected even when the fake test seam is enabled', async () => {
  const handler = createCredentialPreviewHandler({
    policy: { ...allowedPolicy, lane: 'public', callerIdentityVerified: true, ownershipScoped: true, credentialApiVerified: true },
    deploymentEnv: trustedDeploymentEnv, testSeamEnabled: true, fakeOnly: true, resolveCredentials: fakeResolver([]),
  });
  const res = response();
  await handler({ body: { spec: {} } }, res);
  assert.equal(res.statusCode, 404);
});

test('explicit fake seam returns 0/1/many setup manifests without handles', async () => {
  for (const [candidates, _internalStatus, manifestStatus] of [
    [[], 'setup_required', 'setup_required'],
    [[{ handle: 'h1', displayName: 'Calendar', createdAt: 1 }], 'ready', 'ready'],
    [[{ handle: 'h1', displayName: 'A', createdAt: 1 }, { handle: 'h2', displayName: 'B', createdAt: 2 }], 'needs_choice', 'setup_required'],
  ]) {
    const handler = createCredentialPreviewHandler({ policy: allowedPolicy, deploymentEnv: trustedDeploymentEnv, testSeamEnabled: true, fakeOnly: true, resolveCredentials: fakeResolver(candidates) });
    const res = response();
    await handler({ body: { spec: {} } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, manifestStatus);
    assert.equal(res.body.createDisposition, res.body.setupManifest.createDisposition);
    assert.equal(res.body.setupManifest.status, manifestStatus);
    assert.doesNotMatch(JSON.stringify(res.body), /needs_choice|"h[12]"|handle/);
  }
});

test('route registration is explicit and does not alter other app routes', () => {
  const app = { routes: [], post(path, handler) { this.routes.push({ path, handler }); } };
  registerCredentialPreviewRoute(app, { policy: allowedPolicy, testSeamEnabled: false, fakeOnly: true, resolveCredentials: fakeResolver([]) });
  assert.deepEqual(app.routes.map((route) => route.path), ['/beta/conversation/credential-preview']);
});
