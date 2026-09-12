'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyReleaseMapping, createFakeTagStore } = require('./releaseMappingGate');

const sha = 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
const tagSha = 'a0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
const tagStore = createFakeTagStore([{
  tagRef: 'refs/tags/v1.2.3', tagObjectSha: tagSha, targetCommitSha: sha,
  tagVerified: true, immutable: true,
}]);
const tagStoreRc = createFakeTagStore([{
  tagRef: 'refs/tags/v1.2.3-rc.1', tagObjectSha: tagSha, targetCommitSha: sha,
  tagVerified: true, immutable: true,
}]);
const base = () => ({
  version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3', tagObjectSha: tagSha,
  tagVerified: true, immutable: true,
  evidenceRefs: ['a2a/results/runtime.md', 'a2a/results/review.md'],
  evidence: [
    { ref: 'a2a/results/review.md', kind: 'review', version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3' },
    { ref: 'a2a/results/runtime.md', kind: 'runtime', version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3' },
  ],
  liveEvidence: false, status: 'candidate', promotion: { status: 'pending' },
});
const verify = (record, existing = [], store = tagStore) => verifyReleaseMapping(record, existing, { tagStore: store });

test('candidate mapping requires canonical SemVer, fake immutable tag, and matching evidence', () => {
  const result = verify(base());
  assert.equal(result.verified, true);
  assert.equal(result.status, 'candidate');
  assert.equal(result.version, '1.2.3');
  assert.equal(result.targetCommitSha, sha);
});

test('stable requires non-prerelease, live evidence, and explicit Dan promotion source', () => {
  const pending = verify({ ...base(), status: 'stable' });
  assert.equal(pending.code, 'stable_gate_incomplete');
  const promoted = verify({
    ...base(), status: 'stable', liveEvidence: true,
    evidence: [...base().evidence, { ref: 'a2a/results/live.md', kind: 'live', version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3' }],
    evidenceRefs: [...base().evidenceRefs, 'a2a/results/live.md'],
    promotion: { status: 'approved', approvedBy: 'Dan', authorizationSource: 'dan_direct' },
  });
  assert.equal(promoted.verified, true);
  assert.equal(promoted.status, 'stable');
  const prerelease = verify({
    ...base(), version: '1.2.3-rc.1', tagRef: 'refs/tags/v1.2.3-rc.1', status: 'stable', liveEvidence: true,
    evidenceRefs: ['a2a/results/runtime.md', 'a2a/results/review.md', 'a2a/results/live.md'],
    evidence: base().evidence.map((e) => ({ ...e, version: '1.2.3-rc.1', tagRef: 'refs/tags/v1.2.3-rc.1' })).concat({ ref: 'a2a/results/live.md', kind: 'live', version: '1.2.3-rc.1', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3-rc.1' }),
    promotion: { status: 'approved', approvedBy: 'Dan', authorizationSource: 'dan_direct' },
  }, [], tagStoreRc);
  assert.equal(prerelease.code, 'stable_gate_incomplete');
});

test('stable readiness cannot be mislabeled after all gates are present', () => {
  const result = verify({
    ...base(), status: 'ready_for_promotion', liveEvidence: true,
    evidenceRefs: [...base().evidenceRefs, 'a2a/results/live.md'],
    evidence: [...base().evidence, { ref: 'a2a/results/live.md', kind: 'live', version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3' }],
    promotion: { status: 'approved', approvedBy: 'Dan', authorizationSource: 'dan_direct' },
  });
  assert.equal(result.code, 'status_inconsistent');
});

test('short or malformed target SHA cannot satisfy provenance', () => {
  for (const targetCommitSha of ['b0d258d', 'not-a-sha', null]) {
    const result = verify({ ...base(), targetCommitSha });
    assert.equal(result.code, 'full_sha_required');
  }
});

test('tag/version and target/tag identity mismatches are rejected', () => {
  assert.equal(verify({ ...base(), tagRef: 'refs/tags/v1.2.4' }).code, 'tag_ref_mismatch');
  assert.equal(verify({ ...base(), targetCommitSha: tagSha }).code, 'tag_identity_mismatch');
  assert.equal(verify({ ...base(), tagObjectSha: 'b0d258d' }).code, 'tag_sha_invalid');
  const wrongEvidence = { ...base(), evidence: base().evidence.map((e) => ({ ...e, targetCommitSha: tagSha })) };
  assert.equal(verify(wrongEvidence).code, 'evidence_identity_mismatch');
});

test('missing tag store, verification, evidence, or Dan approval fails closed', () => {
  assert.equal(verify(base(), [], null).code, 'tag_store_unavailable');
  for (const patch of [{ immutable: false }, { tagVerified: false }, { evidence: [] }, { evidenceRefs: [] }]) {
    assert.equal(verify({ ...base(), ...patch }).verified, false);
  }
  const notDan = verify({
    ...base(), status: 'stable', liveEvidence: true,
    evidenceRefs: [...base().evidenceRefs, 'a2a/results/live.md'],
    evidence: [...base().evidence, { ref: 'a2a/results/live.md', kind: 'live', version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3' }],
    promotion: { status: 'approved', approvedBy: 'brain', authorizationSource: 'relay' },
  });
  assert.equal(notDan.code, 'stable_gate_incomplete');
});

test('duplicate version or full SHA is rejected one-to-one', () => {
  assert.equal(verify(base(), [{ version: '9.9.9', targetCommitSha: sha }]).code, 'mapping_not_unique');
  assert.equal(verify(base(), [{ version: '1.2.3', targetCommitSha: 'c0d258dbc4dc8a11ccedcf03f526a093e9c2cc23' }]).code, 'mapping_not_unique');
});

test('verified output never returns promotion names or raw record extras', () => {
  const result = verify({ ...base(), promotion: { status: 'approved', approvedBy: 'Dan', secret: 'never' }, rawPrivate: 'never' });
  assert.doesNotMatch(JSON.stringify(result), /Dan|secret|rawPrivate/);
});
