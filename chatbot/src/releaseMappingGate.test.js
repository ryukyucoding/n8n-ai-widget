'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyReleaseMapping } = require('./releaseMappingGate');

const sha = 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
const tagSha = 'a0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
const base = () => ({
  version: '1.2.3',
  targetCommitSha: sha,
  tagRef: 'refs/tags/v1.2.3',
  tagObjectSha: tagSha,
  tagVerified: true,
  immutable: true,
  evidenceRefs: ['a2a/results/runtime.md', 'a2a/results/review.md'],
  liveEvidence: false,
  status: 'candidate',
  promotion: { status: 'pending' },
});

test('candidate mapping requires canonical SemVer, full target SHA, immutable tag facts, and evidence refs', () => {
  const result = verifyReleaseMapping(base());
  assert.equal(result.verified, true);
  assert.equal(result.status, 'candidate');
  assert.equal(result.version, '1.2.3');
  assert.equal(result.targetCommitSha, sha);
});

test('stable requires non-prerelease, live evidence, and explicit Dan promotion', () => {
  const pending = verifyReleaseMapping({ ...base(), status: 'stable' });
  assert.equal(pending.verified, false);
  assert.equal(pending.code, 'stable_gate_incomplete');

  const promoted = verifyReleaseMapping({
    ...base(), status: 'stable', liveEvidence: true,
    promotion: { status: 'approved', approvedBy: 'Dan' },
  });
  assert.equal(promoted.verified, true);
  assert.equal(promoted.status, 'stable');

  const prerelease = verifyReleaseMapping({
    ...base(), version: '1.2.3-rc.1', tagRef: 'refs/tags/v1.2.3-rc.1', status: 'stable',
    liveEvidence: true, promotion: { status: 'approved', approvedBy: 'Dan' },
  });
  assert.equal(prerelease.verified, false);
  assert.equal(prerelease.code, 'stable_gate_incomplete');
});

test('review readiness cannot be mislabeled after all stable gates are present', () => {
  const result = verifyReleaseMapping({
    ...base(), status: 'ready_for_promotion', liveEvidence: true,
    promotion: { status: 'approved', approvedBy: 'Dan' },
  });
  assert.equal(result.verified, false);
  assert.equal(result.code, 'status_inconsistent');
});

test('short or malformed target SHA cannot satisfy provenance', () => {
  for (const targetCommitSha of ['b0d258d', 'not-a-sha', null]) {
    const result = verifyReleaseMapping({ ...base(), targetCommitSha });
    assert.equal(result.verified, false);
    assert.equal(result.code, 'full_sha_required');
  }
});

test('tag/version and target/tag SHA mismatches are rejected', () => {
  const tagMismatch = verifyReleaseMapping({ ...base(), tagRef: 'refs/tags/v1.2.4' });
  assert.equal(tagMismatch.code, 'tag_ref_mismatch');
  const shaMismatch = verifyReleaseMapping({ ...base(), fullSha: tagSha });
  assert.equal(shaMismatch.code, 'target_sha_mismatch');
  const badTagObject = verifyReleaseMapping({ ...base(), tagObjectSha: 'b0d258d' });
  assert.equal(badTagObject.code, 'tag_object_sha_required');
});

test('missing verification, evidence, or Dan approval fails closed', () => {
  for (const patch of [
    { immutable: false },
    { tagVerified: false },
    { evidenceRefs: [] },
    { evidenceRefs: ['../secret.log'] },
  ]) {
    const result = verifyReleaseMapping({ ...base(), ...patch });
    assert.equal(result.verified, false);
  }
  const notDan = verifyReleaseMapping({
    ...base(), status: 'stable', liveEvidence: true,
    promotion: { status: 'approved', approvedBy: 'brain' },
  });
  assert.equal(notDan.verified, false);
});

test('duplicate version or full SHA is rejected while preserving one-to-one mapping', () => {
  const result = verifyReleaseMapping(base(), [{ version: '9.9.9', targetCommitSha: sha }]);
  assert.equal(result.verified, false);
  assert.equal(result.code, 'mapping_not_unique');
  const sameVersion = verifyReleaseMapping(base(), [{ version: '1.2.3', targetCommitSha: 'c0d258dbc4dc8a11ccedcf03f526a093e9c2cc23' }]);
  assert.equal(sameVersion.code, 'mapping_not_unique');
});

test('verified output never returns promotion names or raw record extras', () => {
  const result = verifyReleaseMapping({ ...base(), promotion: { status: 'approved', approvedBy: 'Dan', secret: 'never' }, rawPrivate: 'never' });
  assert.doesNotMatch(JSON.stringify(result), /Dan|secret|rawPrivate/);
});
