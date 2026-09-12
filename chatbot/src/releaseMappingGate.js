'use strict';

// Fake-only release mapping gate. It validates a proposed relationship between
// a human SemVer and immutable release evidence; it does not inspect Git or
// create/move tags. A real release tool must supply the verified record.

const { parseSemVer, classifyGitSha, FULL_GIT_SHA_REGEX } = require('./releaseVersion');

const RELEASE_STATUSES = Object.freeze(['candidate', 'ready_for_promotion', 'stable', 'not-live']);
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

function fail(code, reason) {
  return { verified: false, code, reason, status: 'not-live' };
}

function validEvidenceRefs(refs) {
  return Array.isArray(refs) && refs.length > 0 && refs.length <= 50
    && refs.every((ref) => typeof ref === 'string' && EVIDENCE_REF.test(ref) && !ref.includes('..'));
}

function canonicalVersion(value) {
  const parsed = parseSemVer(value);
  return parsed && parsed.raw === String(value).trim().replace(/^v/i, '') ? parsed : null;
}

function verifyReleaseMapping(record, existingMappings = []) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('mapping_invalid', 'release mapping must be an object');
  const parsed = canonicalVersion(record.version);
  if (!parsed) return fail('version_invalid', 'release mapping version is not canonical SemVer');
  const classification = classifyGitSha(record.fullSha || record.targetCommitSha);
  if (!classification.provenanceGitSha || !FULL_GIT_SHA_REGEX.test(classification.provenanceGitSha)) {
    return fail('full_sha_required', 'release mapping requires a full 40-hex Git SHA');
  }
  if (record.targetCommitSha !== classification.provenanceGitSha) {
    return fail('target_sha_mismatch', 'targetCommitSha must equal the canonical full SHA');
  }
  if (typeof record.tagRef !== 'string' || record.tagRef !== `refs/tags/v${parsed.raw}`) {
    return fail('tag_ref_mismatch', 'tagRef must match the canonical version');
  }
  const tagObject = classifyGitSha(record.tagObjectSha);
  if (!tagObject.provenanceGitSha) return fail('tag_object_sha_required', 'tagObjectSha must be a full 40-hex SHA');
  if (record.tagVerified !== true || record.immutable !== true) {
    return fail('tag_immutability_unverified', 'tag verification and immutability are required');
  }
  if (!validEvidenceRefs(record.evidenceRefs)) {
    return fail('evidence_refs_invalid', 'release evidence refs must be sanitized non-empty A2A refs');
  }
  const duplicate = (Array.isArray(existingMappings) ? existingMappings : []).find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return entry.version === parsed.raw || entry.targetCommitSha === classification.provenanceGitSha;
  });
  if (duplicate) return fail('mapping_not_unique', 'version and full SHA must map one-to-one');

  const requestedStatus = record.status || 'candidate';
  if (!RELEASE_STATUSES.includes(requestedStatus)) return fail('status_invalid', 'release status is not recognized');
  const promotion = record.promotion && typeof record.promotion === 'object' ? record.promotion : {};
  const danApproved = promotion.status === 'approved' && promotion.approvedBy === 'Dan';
  const liveEvidence = record.liveEvidence === true;
  const stableEligible = !parsed.isPrerelease && danApproved && liveEvidence;
  if (requestedStatus === 'stable' && !stableEligible) {
    return fail('stable_gate_incomplete', 'stable requires non-prerelease, live evidence, and Dan promotion');
  }
  if (requestedStatus === 'ready_for_promotion' && stableEligible) {
    return fail('status_inconsistent', 'a fully promoted mapping must be marked stable');
  }

  return {
    verified: true,
    status: stableEligible ? 'stable' : (requestedStatus === 'not-live' ? 'not-live' : requestedStatus),
    version: parsed.raw,
    targetCommitSha: classification.provenanceGitSha,
    tagRef: record.tagRef,
    tagObjectSha: tagObject.provenanceGitSha,
    evidenceRefs: [...record.evidenceRefs],
    danApproved,
    liveEvidence,
  };
}

module.exports = { RELEASE_STATUSES, verifyReleaseMapping, validEvidenceRefs };
