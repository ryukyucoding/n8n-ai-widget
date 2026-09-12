'use strict';

// Fake-only release mapping gate. It validates a proposed relationship between
// a human SemVer, an immutable fake tag record, and sanitized evidence. It does
// not inspect Git, create/move tags, or prove real deployment state. A successful
// result is fixture-level verification only, never cryptographic Dan/A2A auth.

const { parseSemVer, classifyGitSha, FULL_GIT_SHA_REGEX } = require('./releaseVersion');

const RELEASE_STATUSES = Object.freeze(['candidate', 'ready_for_promotion', 'stable', 'not-live']);
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const EVIDENCE_KINDS = new Set(['review', 'runtime', 'live']);

function fail(code, reason) {
  return { verified: false, code, reason, status: 'not-live' };
}

function canonicalVersion(value) {
  const parsed = parseSemVer(value);
  if (!parsed || typeof value !== 'string') return null;
  return parsed.raw === value.trim().replace(/^v/i, '') ? parsed : null;
}

function validEvidenceRefs(refs) {
  return Array.isArray(refs) && refs.length > 0 && refs.length <= 50
    && refs.every((ref) => typeof ref === 'string' && EVIDENCE_REF.test(ref) && !ref.includes('..'));
}

function createFakeTagStore(tags = []) {
  const records = new Map(tags.map((tag) => [tag && tag.tagRef, { ...tag }]));
  return {
    get(tagRef) {
      const tag = records.get(tagRef);
      return tag ? { ...tag } : null;
    },
    _records: records,
  };
}

function verifyTagRecord(record, tagStore) {
  if (!tagStore || typeof tagStore.get !== 'function') return fail('tag_store_unavailable', 'a verified tag store is required');
  if (record.tagVerified !== true || record.immutable !== true) {
    return fail('tag_immutability_unverified', 'release mapping must carry verified immutable tag facts');
  }
  const tag = tagStore.get(record.tagRef);
  if (!tag || tag.tagVerified !== true || tag.immutable !== true) {
    return fail('tag_immutability_unverified', 'tag store did not verify an immutable tag');
  }
  const objectSha = classifyGitSha(tag.tagObjectSha);
  const declaredObjectSha = classifyGitSha(record.tagObjectSha);
  const targetSha = classifyGitSha(tag.targetCommitSha);
  if (!objectSha.provenanceGitSha || !declaredObjectSha.provenanceGitSha || !targetSha.provenanceGitSha) {
    return fail('tag_sha_invalid', 'tag object and target must be full 40-hex SHA values');
  }
  if (declaredObjectSha.provenanceGitSha !== objectSha.provenanceGitSha) {
    return fail('tag_identity_mismatch', 'declared tag object does not match the verified tag record');
  }
  if (targetSha.provenanceGitSha !== record.targetCommitSha || tag.tagRef !== record.tagRef) {
    return fail('tag_identity_mismatch', 'tag evidence does not match the release mapping');
  }
  return { verified: true, tagObjectSha: objectSha.provenanceGitSha };
}

function verifyEvidence(record, parsed) {
  if (!validEvidenceRefs(record.evidenceRefs)) {
    return fail('evidence_refs_invalid', 'release evidence refs must be sanitized non-empty A2A refs');
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    return fail('evidence_identity_missing', 'release evidence identity is required');
  }
  for (const evidence of record.evidence) {
    if (!evidence || typeof evidence !== 'object'
      || !EVIDENCE_REF.test(evidence.ref || '')
      || !EVIDENCE_KINDS.has(evidence.kind)
      || evidence.version !== parsed.raw
      || evidence.targetCommitSha !== record.targetCommitSha
      || evidence.tagRef !== record.tagRef
      || !record.evidenceRefs.includes(evidence.ref)) {
      return fail('evidence_identity_mismatch', 'every evidence item must match version, full SHA, tag, and sanitized ref');
    }
  }
  return { verified: true };
}

function verifyReleaseMapping(record, existingMappings = [], { tagStore } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('mapping_invalid', 'release mapping must be an object');
  const parsed = canonicalVersion(record.version);
  if (!parsed) return fail('version_invalid', 'release mapping version is not canonical SemVer');
  const target = classifyGitSha(record.targetCommitSha);
  if (!target.provenanceGitSha || !FULL_GIT_SHA_REGEX.test(target.provenanceGitSha)) {
    return fail('full_sha_required', 'release mapping requires a full 40-hex Git SHA');
  }
  if (record.targetCommitSha !== target.provenanceGitSha) {
    return fail('target_sha_mismatch', 'targetCommitSha must be canonical lowercase full SHA');
  }
  if (typeof record.tagRef !== 'string' || record.tagRef !== `refs/tags/v${parsed.raw}`) {
    return fail('tag_ref_mismatch', 'tagRef must match the canonical version');
  }
  const tagResult = verifyTagRecord(record, tagStore);
  if (!tagResult.verified) return tagResult;
  const evidenceResult = verifyEvidence(record, parsed);
  if (!evidenceResult.verified) return evidenceResult;

  const duplicate = (Array.isArray(existingMappings) ? existingMappings : []).find((entry) => {
    const entryVersion = canonicalVersion(entry && entry.version);
    return (entryVersion && entryVersion.raw === parsed.raw) || (entry && entry.targetCommitSha === target.provenanceGitSha);
  });
  if (duplicate) return fail('mapping_not_unique', 'version and full SHA must map one-to-one');

  const requestedStatus = record.status || 'candidate';
  if (!RELEASE_STATUSES.includes(requestedStatus)) return fail('status_invalid', 'release status is not recognized');
  const promotion = record.promotion && typeof record.promotion === 'object' ? record.promotion : {};
  const danApproved = promotion.status === 'approved'
    && promotion.approvedBy === 'Dan'
    && promotion.authorizationSource === 'dan_direct';
  const liveEvidence = record.evidence.some((evidence) => evidence.kind === 'live');
  const externalPromotionVerified = promotion.externalRecordVerified === true;
  const allStableGates = !parsed.isPrerelease && danApproved && liveEvidence && externalPromotionVerified;
  // Stable is opt-in: evidence must not silently promote a candidate record.
  if (requestedStatus === 'stable' && !allStableGates) {
    return fail('stable_gate_incomplete', 'stable requires explicit status, external promotion record, non-prerelease, live evidence, and Dan promotion');
  }
  if (requestedStatus === 'ready_for_promotion' && allStableGates) {
    return fail('status_inconsistent', 'a fully promoted mapping must be marked stable');
  }

  return {
    verified: true,
    verificationScope: 'fake_fixture_only',
    status: requestedStatus === 'stable' ? 'stable' : (requestedStatus === 'not-live' ? 'not-live' : requestedStatus),
    version: parsed.raw,
    targetCommitSha: target.provenanceGitSha,
    tagRef: record.tagRef,
    tagObjectSha: tagResult.tagObjectSha,
    evidenceRefs: [...record.evidenceRefs],
    danApproved,
    liveEvidence,
  };
}

module.exports = { RELEASE_STATUSES, verifyReleaseMapping, validEvidenceRefs, createFakeTagStore };
