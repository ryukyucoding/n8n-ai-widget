'use strict';

const { evaluateCredentialAccess } = require('./credentialModeGate');
const { withPrivatePerimeterAssertion } = require('./privatePerimeterConfig');
const { buildSetupManifest } = require('./setupManifest');

// Test-only credential preview route. The real application does not register
// this route unless an explicit fake-only seam is supplied by its test harness.
// It never creates workflows and never calls a real n8n credential adapter.
function createCredentialPreviewHandler({ policy, resolveCredentials, deploymentEnv = process.env, testSeamEnabled = false, fakeOnly = false } = {}) {
  if (typeof resolveCredentials !== 'function') {
    throw new Error('createCredentialPreviewHandler requires resolveCredentials');
  }
  return async function credentialPreviewHandler(req, res) {
    // These are constructor-time server controls, never request-body claims.
    if (testSeamEnabled !== true || fakeOnly !== true) {
      return res.status(404).json({ error: 'credential test seam is disabled', code: 'credential_test_seam_disabled' });
    }
    const gate = evaluateCredentialAccess(withPrivatePerimeterAssertion(policy, deploymentEnv));
    // The fake preview is intentionally solo-only. Public/multi-user credential
    // access is not made testable through this route until real auth/scoping exists.
    if (!gate.allowed || gate.lane !== 'solo') {
      return res.status(404).json({ error: 'credential access is unavailable', code: gate.code || 'credential_access_denied' });
    }
    const spec = req && req.body ? req.body.spec : null;
    try {
      const resolution = await resolveCredentials(spec);
      const manifestSource = resolution && resolution.setupManifest;
      const setupManifest = manifestSource
        ? buildSetupManifest({
          requirements: manifestSource.credentialRequirements || manifestSource.requirements || [],
          configurationRequirements: manifestSource.configurationRequirements || [],
        })
        : buildSetupManifest({ requirements: resolution && resolution.requirements });
      // Public route fields must use the canonical manifest projection; never
      // leak resolver-internal states such as `needs_choice` or raw disposition.
      return res.status(200).json({
        status: setupManifest.status,
        createDisposition: setupManifest.createDisposition,
        setupManifest,
      });
    } catch (_) {
      return res.status(422).json({ error: 'credential preview failed', code: 'credential_preview_failed' });
    }
  };
}

function registerCredentialPreviewRoute(app, options) {
  if (!app || typeof app.post !== 'function') throw new Error('registerCredentialPreviewRoute requires an app');
  app.post('/beta/conversation/credential-preview', createCredentialPreviewHandler(options));
  return app;
}

module.exports = { createCredentialPreviewHandler, registerCredentialPreviewRoute };
