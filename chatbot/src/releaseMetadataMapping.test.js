'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getReleaseMetadata } = require('./releaseVersion');
const { createFakeTagStore } = require('./releaseMappingGate');
const { createFakeReleaseIndex, getReleaseMetadataWithMapping, resolveReleaseMetadataWithMapping } = require('./releaseMetadataMapping');

const sha = 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
const tagSha = 'a0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
const mapping = (over = {}) => ({
  version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3', tagObjectSha: tagSha,
  tagVerified: true, immutable: true,
  evidenceRefs: ['a2a/results/runtime.md'],
  evidence: [{ ref: 'a2a/results/runtime.md', kind: 'runtime', version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3' }],
  status: 'candidate', promotion: { status: 'pending' }, ...over,
});
const tags = createFakeTagStore([{ tagRef: 'refs/tags/v1.2.3', tagObjectSha: tagSha, targetCommitSha: sha, tagVerified: true, immutable: true }]);
const metadata = (over = {}) => getReleaseMetadata({ env: { PRODUCT_RELEASE_VERSION: '1.2.3', GIT_COMMIT_SHA: sha, ...over } });

test('metadata bridge verifies matching candidate mapping and preserves independent revisions', () => {
  const out = getReleaseMetadataWithMapping({ metadata: metadata(), releaseIndex: createFakeReleaseIndex([mapping()]), tagStore: tags });
  assert.equal(out.releaseMappingVerified, true);
  assert.equal(out.lifecycle, 'candidate');
  assert.equal(out.releaseMapping.version, '1.2.3');
  assert.equal(out.releaseMapping.targetCommitSha, sha);
  assert.equal(out.revisions.runtimeSchemaRevision !== out.revisions.skillRegistryRevision, true);
});

test('missing or mismatched mapping fails closed to not-live', () => {
  const missing = getReleaseMetadataWithMapping({ metadata: metadata(), releaseIndex: createFakeReleaseIndex([]), tagStore: tags });
  assert.equal(missing.lifecycle, 'not-live');
  assert.equal(missing.releaseMapping.code, 'mapping_missing');
  const mismatch = getReleaseMetadataWithMapping({ metadata: metadata(), releaseIndex: createFakeReleaseIndex([mapping({ targetCommitSha: 'c0d258dbc4dc8a11ccedcf03f526a093e9c2cc23' })]), tagStore: tags });
  assert.equal(mismatch.lifecycle, 'not-live');
  assert.equal(mismatch.releaseMappingVerified, false);
});

test('metadata SHA mismatch fails closed even when mapping itself is valid', () => {
  const out = getReleaseMetadataWithMapping({
    metadata: metadata({ GIT_COMMIT_SHA: 'b0d258d' }),
    releaseIndex: createFakeReleaseIndex([mapping()]), tagStore: tags,
  });
  assert.equal(out.releaseMappingVerified, false);
  assert.equal(out.releaseMapping.code, 'mapping_sha_mismatch');
});

test('stable mapping requires explicit stable record and external promotion verification', () => {
  const liveEvidence = { ref: 'a2a/results/live.md', kind: 'live', version: '1.2.3', targetCommitSha: sha, tagRef: 'refs/tags/v1.2.3' };
  const record = mapping({ status: 'stable', evidenceRefs: ['a2a/results/live.md'], evidence: [liveEvidence], liveEvidence: true, promotion: { status: 'approved', approvedBy: 'Dan', authorizationSource: 'dan_direct', externalRecordVerified: true } });
  const out = getReleaseMetadataWithMapping({ metadata: metadata(), releaseIndex: createFakeReleaseIndex([record]), tagStore: tags });
  assert.equal(out.lifecycle, 'stable');
  assert.equal(out.releaseMappingVerified, true);
});

test('bridge factory uses injected metadata producer and never wires health/models', () => {
  const resolve = resolveReleaseMetadataWithMapping({ getMetadata: () => metadata(), releaseIndex: createFakeReleaseIndex([mapping()]), tagStore: tags });
  const out = resolve();
  assert.equal(out.releaseMappingVerified, true);
  assert.equal('health' in out, false);
  assert.equal('models' in out, false);
});
