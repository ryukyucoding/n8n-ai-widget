'use strict';

const assert = require('node:assert');
const path = require('node:path');
const {
  CredentialOwnershipBoundary,
  isScalarString,
  TRUSTED_OWNERS_ALLOWLIST,
  TRUSTED_PROVENANCE_ALLOWLIST,
} = require('../src/credentialOwnershipBoundary');

console.log('--- Testing Repaired Pass 2 OVR-1 Credential Ownership Boundary ---');

// 1. Test Trusted Authority & Provenance Contract
const untrustedOwnerBoundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'malicious_admin_injected',
  provenance: 'audit_repair_harness',
});
assert.strictEqual(untrustedOwnerBoundary.boundaryValid, false);
assert.strictEqual(untrustedOwnerBoundary.boundaryError, 'untrusted_authorized_owner_id');

const untrustedProvBoundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'untrusted_external_injection',
});
assert.strictEqual(untrustedProvBoundary.boundaryValid, false);
assert.strictEqual(untrustedProvBoundary.boundaryError, 'untrusted_or_missing_provenance');

// 2. Valid boundary initialization under trusted contract
const boundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});
assert.strictEqual(boundary.boundaryValid, true);

// 3. Test Residual 1: Non-scalar ownerUserId must reject immediately and never fallback
const nonScalarOwnerBoundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'offline_test',
});
const nonScalarOwnerRes = nonScalarOwnerBoundary.loadManifest([
  {
    id: 'cred-1',
    type: 'gmailOAuth2',
    name: 'Gmail',
    ownerUserId: ['daniel'], // Non-scalar array
    owner: 'daniel',        // Must NOT fallback to this
    state: 'active',
  },
]);
console.log('Residual 1 (Non-scalar ownerUserId):', nonScalarOwnerRes.valid, nonScalarOwnerRes.error);
assert.strictEqual(nonScalarOwnerRes.valid, false);
assert.strictEqual(nonScalarOwnerRes.error, 'non_scalar_owner_user_id_at_index_0');

// 4. Test Residual 2: Missing or unknown state must reject and never default to active
const missingStateBoundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'offline_test',
});
const missingStateRes = missingStateBoundary.loadManifest([
  {
    id: 'cred-1',
    type: 'gmailOAuth2',
    name: 'Gmail',
    ownerUserId: 'daniel',
    // Missing state
  },
]);
console.log('Residual 2 (Missing state):', missingStateRes.valid, missingStateRes.error);
assert.strictEqual(missingStateRes.valid, false);
assert.strictEqual(missingStateRes.error, 'missing_state_at_index_0');

const unknownStateRes = missingStateBoundary.loadManifest([
  {
    id: 'cred-1',
    type: 'gmailOAuth2',
    name: 'Gmail',
    ownerUserId: 'daniel',
    state: 'pending_verification', // Unknown state
  },
]);
console.log('Residual 2 (Unknown state):', unknownStateRes.valid, unknownStateRes.error);
assert.strictEqual(unknownStateRes.valid, false);
assert.strictEqual(unknownStateRes.error, 'invalid_state_at_index_0');

// 5. Test Baseline valid manifest
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
  {
    id: 'cred-unowned-github',
    type: 'githubApi',
    name: 'Orphan Github',
    state: 'active',
  },
];

const loadRes = boundary.loadManifest(validManifest);
assert.strictEqual(loadRes.valid, true);
assert.strictEqual(loadRes.count, 5);

// 6. Test Finding 1: Exact type + ID binding (Query ID but mismatched type MUST fail)
const f1Query = boundary.resolveCredentialRequirement({
  type: 'slackApi',
  id: 'cred-dan-gmail',
});
console.log('Finding 1 (Type + ID mismatch):', f1Query.status, f1Query.reason);
assert.strictEqual(f1Query.status, 'unavailable');
assert.strictEqual(f1Query.allowed, false);
assert.strictEqual(f1Query.reason, 'credential_type_mismatch_for_id');

// 7. Test Finding 2: Valid Daniel resolution & trusted provenance
const validDaniel = boundary.resolveCredentialRequirement({
  type: 'gmailOAuth2',
  id: 'cred-dan-gmail',
});
console.log('Finding 2 (Valid Daniel resolution):', validDaniel.status, 'allowed:', validDaniel.allowed);
assert.strictEqual(validDaniel.status, 'available_now');
assert.strictEqual(validDaniel.allowed, true);
assert.deepStrictEqual(validDaniel.opaqueRef, {
  id: 'cred-dan-gmail',
  type: 'gmailOAuth2',
  name: 'Personal Gmail',
});

// 8. Test Finding 4: Foreign rejection never exposes foreign opaque ID
const foreignQuery = boundary.resolveCredentialRequirement({
  type: 'slackApi',
  id: 'cred-foreign-slack',
});
console.log('Finding 4 (Foreign owner rejection):', foreignQuery.status, foreignQuery.reason);
assert.strictEqual(foreignQuery.status, 'unavailable');
assert.strictEqual(foreignQuery.allowed, false);
assert.strictEqual(foreignQuery.reason, 'foreign_owner_rejected');
assert.strictEqual('opaqueRef' in foreignQuery, false);
assert.strictEqual('opaqueId' in foreignQuery, false);
assert.strictEqual('id' in foreignQuery, false);

// 9. Test Secret Exclusion & Change Invariance on Manifest Revision Hash
const originalRev = boundary.getRevision();
const boundaryRecomputed = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});
// Reversing input entries must yield identical revision hash (order-independent)
const reversedManifest = [...validManifest].reverse();
boundaryRecomputed.loadManifest(reversedManifest);
console.log('Revision hash stability:');
console.log('Original hash:   ', originalRev);
console.log('Recomputed hash: ', boundaryRecomputed.getRevision());
assert.strictEqual(boundaryRecomputed.getRevision(), originalRev);

// Tampering with secret fields must NOT alter the manifest revision hash (secret exclusion verification)
const secretTamperedManifest = validManifest.map(m => ({
  ...m,
  password: 'COMPLETELY_DIFFERENT_PASSWORD_12345',
  token: 'tampered_token_xyz',
}));
const boundaryTampered = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});
boundaryTampered.loadManifest(secretTamperedManifest);
console.log('Secret-tampered hash:', boundaryTampered.getRevision());
assert.strictEqual(boundaryTampered.getRevision(), originalRev);

console.log('ALL REPAIRED PASS-2 OVR-1 AUDIT TESTS PASS (100% verified)');
