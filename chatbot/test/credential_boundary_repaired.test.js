'use strict';

const assert = require('node:assert');
const path = require('node:path');
const {
  CredentialOwnershipBoundary,
  isScalarString,
  TRUSTED_CANONICAL_USER_ID,
  TRUSTED_RELATION_CHAIN,
  computeRelationAttestationDigest,
} = require('../src/credentialOwnershipBoundary');

console.log('--- Testing Final Pass-3 OVR-1 Credential Ownership Boundary ---');

// 1. Finding 2 Fix: Test constructor options normalization on null/primitives (Must NEVER throw)
const nullBoundary = new CredentialOwnershipBoundary(null);
assert.strictEqual(nullBoundary.boundaryValid, false);
assert.strictEqual(nullBoundary.boundaryError, 'invalid_non_object_options');
const resOnNull = nullBoundary.resolveCredentialRequirement({ type: 't1' });
assert.strictEqual(resOnNull.status, 'unavailable');
assert.strictEqual(resOnNull.allowed, false);
assert.strictEqual(resOnNull.reason, 'invalid_non_object_options');

const stringBoundary = new CredentialOwnershipBoundary('invalid_primitive_options');
assert.strictEqual(stringBoundary.boundaryValid, false);
assert.strictEqual(stringBoundary.boundaryError, 'invalid_non_object_options');

// 2. Finding 1 Fix: Test Relation-Resolved Ownership Attestation Contract
const invalidAttestationBoundary = new CredentialOwnershipBoundary({
  relationAttestation: {
    canonicalUserId: 'unauthorized_hacker', // Non-Daniel
    projectRole: 'owner',
    relationChain: TRUSTED_RELATION_CHAIN,
  },
});
assert.strictEqual(invalidAttestationBoundary.boundaryValid, false);
assert.strictEqual(invalidAttestationBoundary.boundaryError, 'untrusted_or_invalid_relation_attestation');

const invalidChainBoundary = new CredentialOwnershipBoundary({
  relationAttestation: {
    canonicalUserId: 'daniel',
    projectRole: 'owner',
    relationChain: ['untrusted_direct_link'], // Invalid relation chain
  },
});
assert.strictEqual(invalidChainBoundary.boundaryValid, false);
assert.strictEqual(invalidChainBoundary.boundaryError, 'untrusted_or_invalid_relation_attestation');

// 3. Valid boundary initialization with canonical relation attestation
const validAttestation = {
  canonicalUserId: 'daniel',
  userEmail: 'daniel@local',
  projectRole: 'owner',
  relationChain: TRUSTED_RELATION_CHAIN,
  verifiedAt: '2026-09-20',
};
const boundary = new CredentialOwnershipBoundary({
  relationAttestation: validAttestation,
  provenance: 'audit_repair_harness',
});
assert.strictEqual(boundary.boundaryValid, true);
assert(typeof boundary.relationDigest === 'string' && boundary.relationDigest.length === 64);

// 4. Test Residual: Non-scalar ownerUserId rejection (must NOT fallback to entry.owner)
const nonScalarOwnerBoundary = new CredentialOwnershipBoundary();
const nonScalarRes = nonScalarOwnerBoundary.loadManifest([
  {
    id: 'cred-1',
    type: 'gmailOAuth2',
    name: 'Gmail',
    ownerUserId: { admin: true }, // Non-scalar object
    owner: 'daniel',              // Must NOT fallback
    state: 'active',
  },
]);
assert.strictEqual(nonScalarRes.valid, false);
assert.strictEqual(nonScalarRes.error, 'non_scalar_owner_user_id_at_index_0');

// 5. Test Residual: Missing or unknown state rejection
const missingStateRes = boundary.loadManifest([
  { id: 'cred-1', type: 'gmailOAuth2', name: 'Gmail', ownerUserId: 'daniel' },
]);
assert.strictEqual(missingStateRes.valid, false);
assert.strictEqual(missingStateRes.error, 'missing_state_at_index_0');

// 6. Test Restored Collision Regressions (Duplicate ID & Duplicate type+name)
const dupIdRes = boundary.loadManifest([
  { id: 'cred-same', type: 'typeA', name: 'A', ownerUserId: 'daniel', state: 'active' },
  { id: 'cred-same', type: 'typeB', name: 'B', ownerUserId: 'daniel', state: 'active' },
]);
assert.strictEqual(dupIdRes.valid, false);
assert.strictEqual(dupIdRes.error, 'duplicate_credential_id_collision');

const dupTypeNameRes = boundary.loadManifest([
  { id: 'c1', type: 'gmailOAuth2', name: 'Shared', ownerUserId: 'daniel', state: 'active' },
  { id: 'c2', type: 'gmailOAuth2', name: 'Shared', ownerUserId: 'daniel', state: 'active' },
]);
assert.strictEqual(dupTypeNameRes.valid, false);
assert.strictEqual(dupTypeNameRes.error, 'duplicate_type_and_name_collision');

// 7. Load baseline valid manifest
const validManifest = [
  {
    id: 'cred-dan-gmail',
    type: 'gmailOAuth2',
    name: 'Personal Gmail',
    ownerUserId: 'daniel',
    state: 'active',
    password: 'SUPER_SECRET_VALUE',
  },
  {
    id: 'cred-foreign-slack',
    type: 'slackApi',
    name: 'Foreign Slack',
    ownerUserId: 'external_owner',
    state: 'active',
  },
  {
    id: 'cred-dan-inactive',
    type: 'notionApi',
    name: 'Inactive Notion',
    ownerUserId: 'daniel',
    state: 'inactive',
  },
];
const loadRes = boundary.loadManifest(validManifest);
assert.strictEqual(loadRes.valid, true);
assert.strictEqual(loadRes.count, 3);

// 8. Test Type + ID Exact Binding
const mismatchedTypeQuery = boundary.resolveCredentialRequirement({
  type: 'slackApi',
  id: 'cred-dan-gmail',
});
assert.strictEqual(mismatchedTypeQuery.status, 'unavailable');
assert.strictEqual(mismatchedTypeQuery.allowed, false);
assert.strictEqual(mismatchedTypeQuery.reason, 'credential_type_mismatch_for_id');

// 9. Test Valid Daniel resolution
const validQuery = boundary.resolveCredentialRequirement({
  type: 'gmailOAuth2',
  id: 'cred-dan-gmail',
});
assert.strictEqual(validQuery.status, 'available_now');
assert.strictEqual(validQuery.allowed, true);
assert.deepStrictEqual(validQuery.opaqueRef, {
  id: 'cred-dan-gmail',
  type: 'gmailOAuth2',
  name: 'Personal Gmail',
});

// 10. Test Foreign owner rejection (Zero opaque ID leakage)
const foreignQuery = boundary.resolveCredentialRequirement({
  type: 'slackApi',
  id: 'cred-foreign-slack',
});
assert.strictEqual(foreignQuery.status, 'unavailable');
assert.strictEqual(foreignQuery.allowed, false);
assert.strictEqual(foreignQuery.reason, 'foreign_owner_rejected');
assert.strictEqual('opaqueRef' in foreignQuery, false);
assert.strictEqual('id' in foreignQuery, false);

// 11. Test Secret exclusion & Order-independent Revision Hash
const rev1 = boundary.getRevision();
const boundaryRev = new CredentialOwnershipBoundary({
  relationAttestation: validAttestation,
  provenance: 'audit_repair_harness',
});
const reversedEntries = [...validManifest].reverse();
boundaryRev.loadManifest(reversedEntries);
assert.strictEqual(boundaryRev.getRevision(), rev1);

const tamperedSecretsManifest = validManifest.map(m => ({ ...m, password: 'CHANGED_SECRET_123' }));
const boundaryTampered = new CredentialOwnershipBoundary({
  relationAttestation: validAttestation,
  provenance: 'audit_repair_harness',
});
boundaryTampered.loadManifest(tamperedSecretsManifest);
assert.strictEqual(boundaryTampered.getRevision(), rev1);

console.log('ALL PASS-3 REPAIRED AUDIT TESTS PASS (100% verified)');
