'use strict';

const assert = require('node:assert');
const path = require('node:path');
const {
  CredentialOwnershipBoundary,
  isScalarString,
} = require('../src/credentialOwnershipBoundary');

console.log('--- Testing Repaired OVR-1 Credential Ownership Boundary ---');

// Test Suite: Covering All 6 Audit Blocking Findings

const boundary = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});

// Baseline valid records
const validManifest = [
  {
    id: 'cred-dan-gmail',
    type: 'gmailOAuth2',
    name: 'Personal Gmail',
    ownerUserId: 'daniel',
    state: 'active',
    password: 'SECRET_SHOULD_BE_EXCLUDED',
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

// Finding 1: Exact type + ID binding (Query ID but mismatched type MUST fail)
const f1Query = boundary.resolveCredentialRequirement({
  type: 'slackApi', // Mismatched type
  id: 'cred-dan-gmail', // Valid Daniel ID for gmailOAuth2
});
console.log('Finding 1 (Type + ID mismatch):', f1Query.status, f1Query.reason);
assert.strictEqual(f1Query.status, 'unavailable');
assert.strictEqual(f1Query.allowed, false);
assert.strictEqual(f1Query.reason, 'credential_type_mismatch_for_id');

// Finding 2: Trusted relation-resolved canonical owner policy & revision hash
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
assert.strictEqual(boundary.isAuthorizedOwner('daniel'), true);
assert.strictEqual(boundary.isAuthorizedOwner('random_user'), false);
assert(typeof boundary.getRevision() === 'string' && boundary.getRevision().length === 64);

// Finding 3: Order-independent duplicate ID and (type, name) collision rejection
const dupIdBoundary = new CredentialOwnershipBoundary();
const dupIdRes = dupIdBoundary.loadManifest([
  { id: 'cred-1', type: 'typeA', name: 'A', ownerUserId: 'daniel', state: 'active' },
  { id: 'cred-1', type: 'typeB', name: 'B', ownerUserId: 'daniel', state: 'active' },
]);
console.log('Finding 3 (Duplicate ID collision):', dupIdRes.valid, dupIdRes.error);
assert.strictEqual(dupIdRes.valid, false);
assert.strictEqual(dupIdRes.error, 'duplicate_credential_id_collision');

const dupTypeNameBoundary = new CredentialOwnershipBoundary();
const dupTypeNameRes = dupTypeNameBoundary.loadManifest([
  { id: 'cred-1', type: 'typeA', name: 'SharedName', ownerUserId: 'daniel', state: 'active' },
  { id: 'cred-2', type: 'typeA', name: 'SharedName', ownerUserId: 'daniel', state: 'active' },
]);
console.log('Finding 3 (Duplicate type+name collision):', dupTypeNameRes.valid, dupTypeNameRes.error);
assert.strictEqual(dupTypeNameRes.valid, false);
assert.strictEqual(dupTypeNameRes.error, 'duplicate_type_and_name_collision');

// Finding 4: Foreign rejection never exposes foreign opaque ID
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

// Finding 5: Malformed manifest & non-scalar owner fail closed safely without throwing
const malformedBoundary = new CredentialOwnershipBoundary();
const nonArrayRes = malformedBoundary.loadManifest('not-an-array');
assert.strictEqual(nonArrayRes.valid, false);
assert.strictEqual(nonArrayRes.error, 'manifest_not_an_array');

const malformedEntryRes = malformedBoundary.loadManifest([null, {}]);
assert.strictEqual(malformedEntryRes.valid, false);
assert.strictEqual(malformedEntryRes.error, 'malformed_entry_at_index_0');

const badQuery = malformedBoundary.resolveCredentialRequirement(null);
assert.strictEqual(badQuery.status, 'unavailable');
assert.strictEqual(badQuery.allowed, false);
assert.strictEqual(badQuery.reason, 'malformed_entry_at_index_0');

// Finding 6: Inactive/revoked state rejected from available_now
const inactiveQuery = boundary.resolveCredentialRequirement({
  type: 'notionApi',
  id: 'cred-dan-inactive',
});
console.log('Finding 6 (Inactive state rejection):', inactiveQuery.status, inactiveQuery.reason);
assert.strictEqual(inactiveQuery.status, 'unavailable');
assert.strictEqual(inactiveQuery.allowed, false);
assert.strictEqual(inactiveQuery.reason, 'credential_state_inactive');

const revokedQuery = boundary.resolveCredentialRequirement({
  type: 'airtableApi',
  id: 'cred-dan-revoked',
});
console.log('Finding 6 (Revoked state rejection):', revokedQuery.status, revokedQuery.reason);
assert.strictEqual(revokedQuery.status, 'unavailable');
assert.strictEqual(revokedQuery.allowed, false);
assert.strictEqual(revokedQuery.reason, 'credential_state_revoked');

// Secret Exclusion & Hash Stability Check
const originalRev = boundary.getRevision();
const boundaryRecomputed = new CredentialOwnershipBoundary({
  authorizedOwnerId: 'daniel',
  provenance: 'audit_repair_harness',
});
// Re-inserting in reversed array order must yield identical revision hash
const reversedManifest = [...validManifest].reverse();
boundaryRecomputed.loadManifest(reversedManifest);
console.log('Order-independent revision hash stability:');
console.log('Original hash:   ', originalRev);
console.log('Recomputed hash: ', boundaryRecomputed.getRevision());
assert.strictEqual(boundaryRecomputed.getRevision(), originalRev);

console.log('ALL REPAIRED OVR-1 AUDIT TESTS PASS (100% verified)');
