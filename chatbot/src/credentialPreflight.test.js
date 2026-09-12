'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCredentialPreflight, validatePreflightResult } = require('./credentialPreflight');

const privateFacts = {
  perimeter: { status: 'verified_private', evidenceRefs: ['a2a/preflight/perimeter.md'] },
  callerAuth: { status: 'unknown', method: 'none' },
  credentialApi: { status: 'unknown', readCapability: 'unknown', ownershipScope: 'unknown' },
  singleOperatorConfirmed: true,
};

test('default preflight is blocked and has the v1 shape', () => {
  const result = evaluateCredentialPreflight();
  assert.equal(result.status, 'blocked');
  assert.equal(result.schema, 'credential_preflight/v1');
  assert.doesNotThrow(() => validatePreflightResult(result));
});

test('private solo facts produce solo_test_ready without implying multi-user auth', () => {
  const result = evaluateCredentialPreflight(privateFacts);
  assert.equal(result.status, 'solo_test_ready');
  assert.equal(result.callerAuth.status, 'not_required_for_solo');
  assert.equal(result.credentialApi.status, 'unknown');
  assert.doesNotThrow(() => validatePreflightResult(result));
});

test('private perimeter without single-operator confirmation remains blocked', () => {
  const result = evaluateCredentialPreflight({ ...privateFacts, singleOperatorConfirmed: false });
  assert.equal(result.status, 'blocked');
  assert.match(result.actionsRequired.join(' '), /single-operator/);
});

test('public or unknown perimeter always blocks', () => {
  const result = evaluateCredentialPreflight({
    ...privateFacts, perimeter: { status: 'public_or_unknown', evidenceRefs: [] },
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.assumptionsRejected.join(' '), /public|unknown/);
});

test('multi-user readiness requires trusted identity, authenticated perimeter, and scoped API', () => {
  const result = evaluateCredentialPreflight({
    perimeter: { status: 'verified_authenticated', evidenceRefs: ['a2a/preflight/auth.md'] },
    callerAuth: { status: 'verified', method: 'trusted_proxy' },
    credentialApi: { status: 'verified', readCapability: 'verified', ownershipScope: 'verified' },
  });
  assert.equal(result.status, 'multi_user_ready');
  assert.doesNotThrow(() => validatePreflightResult(result));
});

test('known identity without ownership or credential API stays blocked', () => {
  const result = evaluateCredentialPreflight({
    perimeter: { status: 'verified_authenticated', evidenceRefs: ['a2a/preflight/auth.md'] },
    callerAuth: { status: 'verified', method: 'server_session' },
    credentialApi: { status: 'unknown', readCapability: 'unknown', ownershipScope: 'unknown' },
  });
  assert.equal(result.status, 'blocked');
});

test('fake evidence refs and disclosure text reject secrets, raw paths, and URLs', () => {
  const bad = evaluateCredentialPreflight({
    perimeter: { status: 'verified_private', evidenceRefs: ['https://private.example/x', '../raw.log', 'a2a/good.md'] },
    callerAuth: { status: 'unknown', method: 'none' },
    credentialApi: { status: 'unknown', readCapability: 'unknown', ownershipScope: 'unknown' },
    singleOperatorConfirmed: true,
  });
  // Invalid evidence is represented as missing evidence and therefore cannot
  // be treated as a verified private perimeter result.
  assert.equal(bad.perimeter.evidenceRefs.length, 0);
  assert.equal(bad.status, 'blocked');
  assert.throws(() => validatePreflightResult({ ...bad, actionsRequired: ['sk-secret-token'] }), /disclosure/);
});

test('validator rejects unknown fields and readiness claims with insufficient facts', () => {
  const result = evaluateCredentialPreflight(privateFacts);
  assert.throws(() => validatePreflightResult({ ...result, internalSecret: 'x' }), /forbidden/);
  assert.throws(() => validatePreflightResult({ ...result, status: 'multi_user_ready' }), /multi-user/);
  assert.throws(() => validatePreflightResult({ ...result, status: 'solo_test_ready', perimeter: { status: 'verified_authenticated', evidenceRefs: ['a2a/x.md'] } }), /solo/);
});
