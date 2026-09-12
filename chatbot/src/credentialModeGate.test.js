'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCredentialAccess, assertCredentialAccess } = require('./credentialModeGate');

const solo = {
  lane: 'solo', soloCredentialMode: true, runtimeCompilerEnabled: true,
  apiKeyPresent: true, privatePerimeterVerified: true,
};

const publicReady = {
  lane: 'public', runtimeCompilerEnabled: true, apiKeyPresent: true,
  callerIdentityVerified: true, ownershipScoped: true, credentialApiVerified: true,
};

test('solo credential access requires the explicit mode flag', () => {
  const result = evaluateCredentialAccess({ ...solo, soloCredentialMode: false });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'solo_credential_mode_disabled');
});

test('solo credential access fails closed without a verified private perimeter', () => {
  for (const value of [undefined, false, 'true', 1]) {
    const result = evaluateCredentialAccess({ ...solo, privatePerimeterVerified: value });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'private_perimeter_unverified');
  }
});

test('solo credential access requires runtime and server n8n access', () => {
  assert.equal(evaluateCredentialAccess({ ...solo, runtimeCompilerEnabled: false }).code, 'runtime_compiler_disabled');
  assert.equal(evaluateCredentialAccess({ ...solo, apiKeyPresent: false }).code, 'n8n_api_key_missing');
});

test('public credential access fails closed without identity, ownership, and API facts', () => {
  for (const key of ['callerIdentityVerified', 'ownershipScoped', 'credentialApiVerified']) {
    const result = evaluateCredentialAccess({ ...publicReady, [key]: false });
    assert.equal(result.allowed, false);
  }
});

test('a browser-supplied solo claim does not satisfy the server policy', () => {
  const result = evaluateCredentialAccess({
    lane: 'public', soloCredentialMode: true, privatePerimeterVerified: true,
    runtimeCompilerEnabled: true, apiKeyPresent: true,
    callerIdentityVerified: false, ownershipScoped: false, credentialApiVerified: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'caller_identity_unverified');
});

test('fully verified solo and public lanes are explicit and distinguishable', () => {
  assert.deepEqual(evaluateCredentialAccess(solo), { allowed: true, lane: 'solo', code: null, reason: null });
  assert.deepEqual(evaluateCredentialAccess(publicReady), { allowed: true, lane: 'public', code: null, reason: null });
});

test('assertCredentialAccess throws a coded fail-closed error', () => {
  assert.throws(() => assertCredentialAccess({ ...solo, privatePerimeterVerified: false }), (error) => {
    assert.equal(error.code, 'private_perimeter_unverified');
    return true;
  });
});
