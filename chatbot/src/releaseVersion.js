'use strict';

// Canonical release metadata adapter.
// Bridges human-readable SemVer (MAJOR.MINOR.PATCH[-PRERELEASE]) with machine-level
// immutable Git SHAs and cryptographic schema/skill revisions.
//
// Invariants:
// 1. Never replaces cryptographic hashes in planBinding HMAC signatures.
// 2. Strict fail-closed version parsing: explicit malformed version strings throw.
// 3. Strict fail-closed lifecycle parsing: explicit malformed lifecycle strings throw.
// 4. Stable lifecycle strictly requires a full 40-hex provenance SHA + non-prerelease version.
// 5. Leaves `/health` and `/models` unwired until authorized.
// 6. Safe against JS number precision loss for huge numeric identifiers.
// 7. Strictly separates provenanceGitSha (full 40-hex only) from diagnosticGitSha (7-39 hex).

const crypto = require('node:crypto');
const runtimeSnapshot = require('../schemas/runtime_node_schemas.json');
const { SKILLS } = require('./runtimeSkillRegistry');
const { schemaRevision } = require('./runtimeSchemaRevision');
const { sourceRegistryRevision } = require('./sourceSchemaRegistry');

// Strict SemVer 2.0.0 pattern without leading zeros for numeric components
const SEMVER_STRICT_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Full Git SHA regex: exactly 40 hexadecimal characters
const FULL_GIT_SHA_REGEX = /^[0-9a-f]{40}$/i;

// Short / Diagnostic Git SHA regex: 7 to 39 hexadecimal characters
const SHORT_GIT_SHA_REGEX = /^[0-9a-f]{7,39}$/i;

// Supported lifecycle states
const LIFECYCLE_STATES = Object.freeze(['candidate', 'stable', 'not-live']);

// Proposed default candidate version for Brain/Dan decision
const PROPOSED_DEFAULT_RELEASE_VERSION = '0.4.0-rc.1';

// Maximum safe string length for version inputs to prevent ReDoS/overflow
const MAX_VERSION_INPUT_LEN = 128;

// Parse and validate SemVer string strictly:
// - Disallow internal whitespace
// - Strip single leading 'v' or 'V' only
// - Disallow leading zeros in numeric components (e.g. '01.2.3' is invalid)
// - Preserve numeric strings to avoid JS Number (IEEE-754) precision truncation
function parseSemVer(versionStr) {
  if (typeof versionStr !== 'string') return null;
  const trimmed = versionStr.trim();
  if (!trimmed || trimmed.length > MAX_VERSION_INPUT_LEN) return null;
  // Disallow internal whitespace
  if (/\s/.test(trimmed)) return null;

  const normalized = trimmed.replace(/^v/i, '');
  if (!SEMVER_STRICT_REGEX.test(normalized)) return null;

  const match = normalized.match(SEMVER_STRICT_REGEX);
  const majorStr = match[1];
  const minorStr = match[2];
  const patchStr = match[3];

  return {
    raw: normalized,
    tag: `v${normalized}`,
    major: majorStr,
    minor: minorStr,
    patch: patchStr,
    majorNumber: Number(majorStr) <= Number.MAX_SAFE_INTEGER ? Number(majorStr) : null,
    minorNumber: Number(minorStr) <= Number.MAX_SAFE_INTEGER ? Number(minorStr) : null,
    patchNumber: Number(patchStr) <= Number.MAX_SAFE_INTEGER ? Number(patchStr) : null,
    prerelease: match[4] || null,
    build: match[5] || null,
    isPrerelease: Boolean(match[4]),
  };
}

// Strictly separate provenance Git SHA (full 40-hex only) from diagnostic Git SHA (7-39 hex)
function classifyGitSha(sha) {
  if (typeof sha !== 'string') {
    return { provenanceGitSha: null, diagnosticGitSha: null, grade: null };
  }
  const trimmed = sha.trim().toLowerCase();
  if (FULL_GIT_SHA_REGEX.test(trimmed)) {
    return { provenanceGitSha: trimmed, diagnosticGitSha: null, grade: 'full' };
  }
  if (SHORT_GIT_SHA_REGEX.test(trimmed)) {
    return { provenanceGitSha: null, diagnosticGitSha: trimmed, grade: 'diagnostic' };
  }
  return { provenanceGitSha: null, diagnosticGitSha: null, grade: null };
}

// Determine release lifecycle state explicitly:
// - Fail-closed: invalid non-empty lifecycle string throws Error.
// - Invariant: 'stable' strictly requires:
//     1. Parsed version is NOT prerelease.
//     2. Provenance Git SHA is full 40-hex (cannot be stable on short SHA or missing SHA).
function resolveLifecycle(parsed, env = process.env, provenanceSha = null) {
  if (!parsed) return 'not-live';

  const rawName = env.RELEASE_LIFECYCLE ? 'RELEASE_LIFECYCLE' : (env.PRODUCT_LIFECYCLE ? 'PRODUCT_LIFECYCLE' : null);
  const rawValue = rawName ? env[rawName] : null;

  if (typeof rawValue === 'string' && rawValue.trim() !== '') {
    const trimmed = rawValue.trim().toLowerCase();
    if (!LIFECYCLE_STATES.includes(trimmed)) {
      const err = new Error(`Invalid ${rawName}: "${rawValue}" is not one of [candidate, stable, not-live]`);
      err.code = 'invalid_release_lifecycle';
      throw err;
    }
    // Safety guard: 'stable' can NEVER override a prerelease version (e.g. 0.4.0-rc.1)
    if (trimmed === 'stable' && parsed.isPrerelease) {
      return 'candidate';
    }
    // Safety guard: 'stable' strictly requires a 40-hex provenance SHA
    if (trimmed === 'stable' && (!provenanceSha || !FULL_GIT_SHA_REGEX.test(provenanceSha))) {
      return 'candidate'; // Fallback to candidate if missing full provenance SHA
    }
    return trimmed;
  }

  // Derived: stable requires both non-prerelease AND full provenance SHA
  if (!parsed.isPrerelease && provenanceSha && FULL_GIT_SHA_REGEX.test(provenanceSha)) {
    return 'stable';
  }
  return 'candidate';
}

// Resolve product version with fail-closed semantics:
// - If PRODUCT_RELEASE_VERSION is set:
//     * Valid SemVer -> use it.
//     * Invalid non-empty string -> throw Error (fail-closed, do not silently fallback and mask bad config!).
// - If PRODUCT_RELEASE_VERSION is unset/empty, check RELEASE_VERSION:
//     * Valid SemVer -> use it.
//     * Invalid non-empty string -> throw Error (fail-closed).
// - If both unset/empty -> return PROPOSED_DEFAULT_RELEASE_VERSION.
function resolveProductVersion(env = process.env) {
  const hasProduct = typeof env.PRODUCT_RELEASE_VERSION === 'string' && env.PRODUCT_RELEASE_VERSION.trim() !== '';
  if (hasProduct) {
    const parsed = parseSemVer(env.PRODUCT_RELEASE_VERSION);
    if (!parsed) {
      const err = new Error(`Invalid PRODUCT_RELEASE_VERSION: "${env.PRODUCT_RELEASE_VERSION}" is not a valid SemVer string`);
      err.code = 'invalid_product_release_version';
      throw err;
    }
    return parsed.raw;
  }

  const hasRelease = typeof env.RELEASE_VERSION === 'string' && env.RELEASE_VERSION.trim() !== '';
  if (hasRelease) {
    const parsed = parseSemVer(env.RELEASE_VERSION);
    if (!parsed) {
      const err = new Error(`Invalid RELEASE_VERSION: "${env.RELEASE_VERSION}" is not a valid SemVer string`);
      err.code = 'invalid_release_version';
      throw err;
    }
    return parsed.raw;
  }

  return PROPOSED_DEFAULT_RELEASE_VERSION;
}

function skillRegistryRevision(skillRegistry = SKILLS) {
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return crypto.createHash('sha256').update(stableStringify(skillRegistry)).digest('hex');
}

// Produce comprehensive release metadata
function getReleaseMetadata({
  env = process.env,
  gitSha = null,
  snapshot = runtimeSnapshot,
  skillRegistry = SKILLS,
  sourceRegistry,
} = {}) {
  const rawVersion = resolveProductVersion(env);
  const parsed = parseSemVer(rawVersion);

  const rawSha = gitSha || env.GIT_COMMIT_SHA || env.GIT_SHA || env.REVISION || null;
  const { provenanceGitSha, diagnosticGitSha, grade: shaGrade } = classifyGitSha(rawSha);

  const lifecycle = resolveLifecycle(parsed, env, provenanceGitSha);

  return {
    version: parsed ? parsed.raw : rawVersion,
    tag: parsed ? parsed.tag : `v${rawVersion}`,
    isPrerelease: parsed ? parsed.isPrerelease : true,
    lifecycle,
    revisions: {
      provenanceGitSha, // Full 40-hex SHA required for release provenance, else null
      diagnosticGitSha, // 7-39 hex short SHA for diagnostics only, else null
      gitRevisionGrade: shaGrade, // 'full' | 'diagnostic' | null
      runtimeSchemaRevision: schemaRevision(snapshot).revision,
      skillRegistryRevision: skillRegistryRevision(skillRegistry),
      sourceRegistryRevision: sourceRegistryRevision(sourceRegistry),
    },
  };
}

module.exports = {
  SEMVER_STRICT_REGEX,
  FULL_GIT_SHA_REGEX,
  SHORT_GIT_SHA_REGEX,
  LIFECYCLE_STATES,
  PROPOSED_DEFAULT_RELEASE_VERSION,
  parseSemVer,
  classifyGitSha,
  resolveLifecycle,
  resolveProductVersion,
  getReleaseMetadata,
};
