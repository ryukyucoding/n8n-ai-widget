'use strict';

const assert = require('node:assert');
const path = require('node:path');
const {
  CredentialOwnershipBoundary,
  isScalarString,
  getTrustedOwnersAllowlist,
  getTrustedProvenanceAllowlist,
} = require('../src/credentialOwnershipBoundary');

console.log('--- Testing Final Repaired OVR-1 Credential Ownership Boundary ---');

// 1. Residual 1 Test: Trusted Authority Sets Immutability & Mutation Regression
const ownersList = getTrustedOwnersAllowlist();
assert(Array.isArray(ownersList) && ownersList.includes('daniel'));
// Verify mutation attempt on returned list does not affect boundary validation
ownersList.push('injected_fake_owner');
const testBoundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'injected_fake_owner',
});
assert.strictEqual(testBoundary.boundaryValid, false);
assert.strictEqual(testBoundary.boundaryError, 'untrusted_authorized_owner_id');

// 2. Residual 2 Test: Safe fail-closed on invalid constructor without unhandled exceptions
const invalidCtorBoundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'unauthorized_attacker',
  provenance: 'untrusted_location',
});
assert.strictEqual(invalidCtorBoundary.boundaryValid, false);
// Instance methods must fail closed safely without throwing
const loadOnInvalid = invalidCtorBoundary.loadManifest([{ id: 'c1', type: 't1', state: 'active' }]);
assert.strictEqual(loadOnInvalid.valid, false);
assert.strictEqual(loadOnInvalid.error, 'untrusted_authorized_owner_id');

const resolveOnInvalid = invalidCtorBoundary.resolveCredentialRequirement({ type: 't1' });
assert.strictEqual(resolveOnInvalid.status, 'unavailable');
assert.strictEqual(resolveOnInvalid.allowed, false);
assert.strictEqual(resolveOnInvalid.reason, 'untrusted_authorized_owner_id');
assert.strictEqual(typeof invalidCtorBoundary.getRevision(), 'string');

// 3. Valid boundary initialization under trusted contract
const boundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});
assert.strictEqual(boundary.boundaryValid, true);

// 4. Residual 3 Test: Restored duplicate ID, duplicate (type, name) collision, and ambiguous type tests
const dupIdBoundary = new CredentialOwnershipBoundary();
const dupIdRes = dupIdBoundary.loadManifest([
  { id: 'cred-same-id', type: 'typeA', name: 'NameA', ownerUserId: 'daniel', state: 'active' },
  { id: 'cred-same-id', type: 'typeB', name: 'NameB', ownerUserId: 'daniel', state: 'active' },
]);
console.log('Restored Collision Test (Duplicate ID):', dupIdRes.valid, dupIdRes.error);
assert.strictEqual(dupIdRes.valid, false);
assert.strictEqual(dupIdRes.error, 'duplicate_credential_id_collision');

const dupTypeNameBoundary = new CredentialOwnershipBoundary();
const dupTypeNameRes = dupTypeNameBoundary.loadManifest([
  { id: 'cred-1', type: 'gmailOAuth2', name: 'SharedName', ownerUserId: 'daniel', state: 'active' },
  { id: 'cred-2', type: 'gmailOAuth2', name: 'SharedName', ownerUserId: 'daniel', state: 'active' },
]);
console.log('Restored Collision Test (Duplicate type+name):', dupTypeNameRes.valid, dupTypeNameRes.error);
assert.strictEqual(dupTypeNameRes.valid, false);
assert.strictEqual(dupTypeNameRes.error, 'duplicate_type_and_name_collision');

// Ambiguous type-only resolution test (multiple valid Daniel credentials of same type without ID/name)
const ambigBoundary = new CredentialOwnershipBoundary();
ambigBoundary.loadManifest([
  { id: 'cred-gmail-1', type: 'gmailOAuth2', name: 'Gmail 1', ownerUserId: 'daniel', state: 'active' },
  { id: 'cred-gmail-2', type: 'gmailOAuth2', name: 'Gmail 2', ownerUserId: 'daniel', state: 'active' },
]);
const ambigQuery = ambigBoundary.resolveCredentialRequirement({ type: 'gmailOAuth2' });
console.log('Restored Ambiguous Type Query:', ambigQuery.status, ambigQuery.reason);
assert.strictEqual(ambigQuery.status, 'unavailable');
assert.strictEqual(ambigQuery.allowed, false);
assert.strictEqual(ambigQuery.reason, 'ambiguous_multiple_credentials');
assert.strictEqual(ambigQuery.candidateCount, 2);

// 5. Test Non-scalar ownerUserId rejection (never fallback to entry.owner)
const nonScalarOwnerBoundary = new CredentialOwnershipBoundary();
const nonScalarOwnerRes = nonScalarOwnerBoundary.loadManifest([
  {
    id: 'cred-1',
    type: 'gmailOAuth2',
    name: 'Gmail',
    ownerUserId: ['daniel'], // Non-scalar array
    owner: 'daniel',        // Must NOT fallback
    state: 'active',
  },
]);
assert.strictEqual(nonScalarOwnerRes.valid, false);
assert.strictEqual(nonScalarOwnerRes.error, 'non_scalar_owner_user_id_at_index_0');

// 6. Test Missing or unknown state rejection (never defaults to active)
const missingStateBoundary = new CredentialOwnershipBoundary();
const missingStateRes = missingStateBoundary.loadManifest([
  { id: 'cred-1', type: 'gmailOAuth2', name: 'Gmail', ownerUserId: 'daniel' },
]);
assert.strictEqual(missingStateRes.valid, false);
assert.strictEqual(missingStateRes.error, 'missing_state_at_index_0');

const unknownStateRes = missingStateBoundary.loadManifest([
  { id: 'cred-1', type: 'gmailOAuth2', name: 'Gmail', ownerUserId: 'daniel', state: 'pending' },
]);
assert.strictEqual(unknownStateRes.valid, false);
assert.strictEqual(unknownStateRes.error, 'invalid_state_at_index_0');

// 7. Baseline valid manifest & findings
const validManifest = [
  {
    id: 'cred-dan-gmail',
    type: 'gmailOAuth2',
    name: 'Personal Gmail',
    ownerUserId: 'daniel',
    state: 'active',
    password: 'SECRET_SHOULD_BE_EXCLUDED',
    token: 'ya29.secret_token',
  },
  {
    id: 'cred-foreign-slack',
    type: 'slackApi',
    name: 'Enterprise Slack',
    ownerUserId: 'external_admin',
    state: 'active',
  },
  {
    id: 'cred-dan-inactive',
    type: 'notionApi',
    name: 'Old Notion',
    ownerUserId: 'daniel',
    state: 'inactive',
  },
  {
    id: 'cred-dan-revoked',
    type: 'airtableApi',
    name: 'Revoked Airtable',
    ownerUserId: 'daniel',
    state: 'revoked',
  },
];

const loadRes = boundary.loadManifest(validManifest);
assert.strictEqual(loadRes.valid, true);
assert.strictEqual(loadRes.count, 4);

// Finding 1: Exact type + ID binding (Query ID but mismatched type MUST fail)
const f1Query = boundary.resolveCredentialRequirement({
  type: 'slackApi',
  id: 'cred-dan-gmail',
});
assert.strictEqual(f1Query.status, 'unavailable');
assert.strictEqual(f1Query.allowed, false);
assert.strictEqual(f1Query.reason, 'credential_type_mismatch_for_id');

// Finding 2: Valid Daniel resolution & trusted provenance
const validDaniel = boundary.resolveCredentialRequirement({
  type: 'gmailOAuth2',
  id: 'cred-dan-gmail',
});
assert.strictEqual(validDaniel.status, 'available_now');
assert.strictEqual(validDaniel.allowed, true);
assert.deepStrictEqual(validDaniel.opaqueRef, {
  id: 'cred-dan-gmail',
  type: 'gmailOAuth2',
  name: 'Personal Gmail',
});

// Finding 4: Foreign rejection never exposes foreign opaque ID
const foreignQuery = boundary.resolveCredentialRequirement({
  type: 'slackApi',
  id: 'cred-foreign-slack',
});
assert.strictEqual(foreignQuery.status, 'unavailable');
assert.strictEqual(foreignQuery.allowed, false);
assert.strictEqual(foreignQuery.reason, 'foreign_owner_rejected');
assert.strictEqual('opaqueRef' in foreignQuery, false);
assert.strictEqual('opaqueId' in foreignQuery, false);
assert.strictEqual('id' in foreignQuery, false);

// Secret Exclusion & Hash Stability Check (order-independent & secret-tampered)
const originalRev = boundary.getRevision();
const boundaryRecomputed = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});
const reversedManifest = [...validManifest].reverse();
boundaryRecomputed.loadManifest(reversedManifest);
assert.strictEqual(boundaryRecomputed.getRevision(), originalRev);

const secretTamperedManifest = validManifest.map(m => ({
  ...m,
  password: 'DIFFERENT_PASSWORD_12345',
  token: 'tampered_token_xyz',
}));
const boundaryTampered = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});
boundaryTampered.loadManifest(secretTamperedManifest);
assert.strictEqual(boundaryTampered.getRevision(), originalRev);

console.log('ALL FINAL REPAIRED OVR-1 AUDIT TESTS PASS (100% verified)');
