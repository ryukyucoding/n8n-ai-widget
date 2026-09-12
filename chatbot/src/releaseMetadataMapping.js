'use strict';

// Dependency-injected bridge between release metadata and the fake release
// mapping gate. This is test-only: it does not read Git, inspect tags, or wire
// /health or /models. A real release index must be supplied by the release tool.

const { parseSemVer } = require('./releaseVersion');
const { verifyReleaseMapping } = require('./releaseMappingGate');

function canonicalVersion(value) {
  const parsed = parseSemVer(value);
  return parsed ? parsed.raw : null;
}

function createFakeReleaseIndex(records = []) {
  const entries = records.map((record) => Object.freeze({ ...record }));
  return Object.freeze({
    get(version) {
      const key = canonicalVersion(version);
      return entries.find((record) => canonicalVersion(record.version) === key) || null;
    },
    list() {
      return entries.map((record) => ({ ...record }));
    },
  });
}

function publicMapping(result) {
  if (!result || !result.verified) {
    return { verified: false, status: 'not-live', code: result && result.code, reason: result && result.reason };
  }
  return {
    verified: true,
    status: result.status,
    version: result.version,
    targetCommitSha: result.targetCommitSha,
    tagRef: result.tagRef,
    tagObjectSha: result.tagObjectSha,
    evidenceRefs: [...result.evidenceRefs],
    verificationScope: 'fake_fixture_only',
  };
}

function getReleaseMetadataWithMapping({
  metadata,
  releaseIndex,
  tagStore,
} = {}) {
  if (!metadata || typeof metadata !== 'object') throw new Error('metadata is required');
  const version = canonicalVersion(metadata.version);
  if (!version) {
    return { ...metadata, lifecycle: 'not-live', releaseMappingVerified: false, releaseMapping: { verified: false, status: 'not-live', code: 'metadata_version_invalid' } };
  }
  if (!releaseIndex || typeof releaseIndex.get !== 'function' || typeof releaseIndex.list !== 'function') {
    return { ...metadata, lifecycle: 'not-live', releaseMappingVerified: false, releaseMapping: { verified: false, status: 'not-live', code: 'mapping_index_unavailable' } };
  }
  const record = releaseIndex.get(version);
  if (!record) {
    return { ...metadata, lifecycle: 'not-live', releaseMappingVerified: false, releaseMapping: { verified: false, status: 'not-live', code: 'mapping_missing' } };
  }
  const check = verifyReleaseMapping(record, releaseIndex.list().filter((entry) => entry !== record && entry.version !== record.version), { tagStore });
  if (!check.verified) {
    return { ...metadata, lifecycle: 'not-live', releaseMappingVerified: false, releaseMapping: publicMapping(check) };
  }
  if (check.version !== version) {
    return { ...metadata, lifecycle: 'not-live', releaseMappingVerified: false, releaseMapping: { verified: false, status: 'not-live', code: 'mapping_version_mismatch' } };
  }
  if (metadata.revisions && metadata.revisions.provenanceGitSha !== check.targetCommitSha) {
    return { ...metadata, lifecycle: 'not-live', releaseMappingVerified: false, releaseMapping: { verified: false, status: 'not-live', code: 'mapping_sha_mismatch' } };
  }
  return {
    ...metadata,
    lifecycle: check.status,
    releaseMappingVerified: true,
    releaseMapping: publicMapping(check),
  };
}

function resolveReleaseMetadataWithMapping({ getMetadata, releaseIndex, tagStore } = {}) {
  if (typeof getMetadata !== 'function') throw new Error('getMetadata is required');
  return (options = {}) => getReleaseMetadataWithMapping({
    metadata: getMetadata(options), releaseIndex, tagStore,
  });
}

module.exports = { createFakeReleaseIndex, getReleaseMetadataWithMapping, resolveReleaseMetadataWithMapping };
