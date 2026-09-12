'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeCredentialBinding, credentialApprovalContext } = require('./fakeCredentialBinding');
const { computeFingerprint } = require('./planBinding');

const records = [
  { credentialType: 'gmailOAuth2', handle: 'h1', displayName: 'Gmail A', owner: 'solo', scope: 'p1', createdAt: 10, lastUsedAt: 20, version: 1, secret: 'never-return' },
  { credentialType: 'gmailOAuth2', handle: 'h2', displayName: 'Gmail B', owner: 'other', scope: 'p1', createdAt: 30, version: 1 },
  { credentialType: 'googleCalendarOAuth2Api', handle: 'stale', displayName: 'Old Calendar', owner: 'solo', scope: 'p1', stale: true, createdAt: 1 },
];

test('fake lister returns only caller-owned, non-stale candidates and no private fields', async () => {
  const adapter = createFakeCredentialBinding({ records });
  const result = await adapter.listCandidates('gmailOAuth2', { callerId: 'solo', scope: 'p1' });
  assert.deepEqual(result, [{ handle: 'h1', displayName: 'Gmail A', createdAt: 10, lastUsedAt: 20 }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|owner|scope/);
});

test('fake binder rejects foreign, stale, and missing handles', async () => {
  const adapter = createFakeCredentialBinding({ records });
  await assert.rejects(() => adapter.bindCredential({ credentialType: 'gmailOAuth2', handle: 'h2', callerId: 'solo', scope: 'p1' }), /not_owned/);
  await assert.rejects(() => adapter.bindCredential({ credentialType: 'googleCalendarOAuth2Api', handle: 'stale', callerId: 'solo', scope: 'p1' }), /not_found|stale/);
  await assert.rejects(() => adapter.bindCredential({ credentialType: 'gmailOAuth2', handle: 'missing', callerId: 'solo', scope: 'p1' }), /not_found/);
});

test('fake binder returns server binding separately from public metadata', async () => {
  const adapter = createFakeCredentialBinding({ records });
  const result = await adapter.bindCredential({ credentialType: 'gmailOAuth2', handle: 'h1', callerId: 'solo', scope: 'p1' });
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, 'Gmail A');
  assert.equal(result.serverBinding.handle, 'h1');
  assert.equal(result.serverBinding.credentialName, 'Gmail A');
});

test('credential binding context changes approval fingerprint without putting name in token body', () => {
  const ir = { version: '1', goal: 'g', steps: [], expectedOutput: {} };
  const base = { runtimeSchemaRevision: 'r1', skillRegistryRevision: 's1' };
  const a = credentialApprovalContext({ createDisposition: 'bind_and_create', requirements: [{ credentialType: 'gmailOAuth2', status: 'ready', selectedDisplayName: 'Gmail A', bindingRevision: 'b1' }] });
  const b = credentialApprovalContext({ createDisposition: 'bind_and_create', requirements: [{ credentialType: 'gmailOAuth2', status: 'ready', selectedDisplayName: 'Gmail B', bindingRevision: 'b2' }] });
  assert.notEqual(a.credentialBindingRevision, b.credentialBindingRevision);
  assert.notEqual(computeFingerprint(ir, { ...base, ...a }), computeFingerprint(ir, { ...base, ...b }));
  assert.doesNotMatch(JSON.stringify(a), /Gmail A|h1|secret/);
});
