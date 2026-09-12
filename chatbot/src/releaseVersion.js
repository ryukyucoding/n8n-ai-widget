'use strict';

// Canonical release metadata adapter.
// Bridges human-readable SemVer (MAJOR.MINOR.PATCH[-PRERELEASE]) with machine-level
// immutable Git SHAs and cryptographic schema/skill revisions.
//
// Invariants:
// 1. Never replaces cryptographic hashes in planBinding HMAC signatures.
// 2. Fallback candidate version is configurable via environment variable `PRODUCT_RELEASE_VERSION`.
// 3. Leaves `/health` and `/models` unwired until authorized.
// 4. Safe against JS number precision loss for huge numeric identifiers (keeps string representation).
// 5. Strict Git SHA validation (7-40 hex chars).

const crypto = require('node:crypto');
const runtimeSnapshot = require('../schemas/runtime_node_schemas.json');
const { SKILLS } = require('./runtimeSkillRegistry');
const { schemaRevision } = require('./runtimeSchemaRevision');
const { sourceRegistryRevision } = require('./sourceSchemaRegistry');

// Strict SemVer 2.0.0 pattern without leading zeros for numeric components
const SEMVER_STRICT_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Git SHA regex: 7 to 40 hexadecimal characters
const GIT_SHA_REGEX = /^[0-9a-f]{7,40}$/i;

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
    // Provide safe numbers only when within JavaScript safe integer bounds
    majorNumber: Number(majorStr) <= Number.MAX_SAFE_INTEGER ? Number(majorStr) : null,
    minorNumber: Number(minorStr) <= Number.MAX_SAFE_INTEGER ? Number(minorStr) : null,
    patchNumber: Number(patchStr) <= Number.MAX_SAFE_INTEGER ? Number(patchStr) : null,
    prerelease: match[4] || null,
    build: match[5] || null,
    isPrerelease: Boolean(match[4]),
  };
}

// Validate supplied Git SHA format strictly
function validateGitSha(sha) {
  if (typeof sha !== 'string') return null;
  const trimmed = sha.trim();
  return GIT_SHA_REGEX.test(trimmed) ? trimmed.toLowerCase() : null;
}

// Determine release lifecycle state explicitly
function resolveLifecycle(parsed, env = process.env) {
  const explicit = env.RELEASE_LIFECYCLE || env.PRODUCT_LIFECYCLE;
  if (explicit && LIFECYCLE_STATES.includes(String(explicit).toLowerCase())) {
    return String(explicit).toLowerCase();
  }
  if (!parsed) return 'not-live';
  return parsed.isPrerelease ? 'candidate' : 'stable';
}

// Resolve product version from environment with safe fallback
function resolveProductVersion(env = process.env) {
  const configured = env.PRODUCT_RELEASE_VERSION || env.RELEASE_VERSION;
  if (configured && parseSemVer(configured)) {
    return parseSemVer(configured).raw;
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
  const lifecycle = resolveLifecycle(parsed, env);

  const rawSha = gitSha || env.GIT_COMMIT_SHA || env.GIT_SHA || env.REVISION || null;
  const validatedSha = validateGitSha(rawSha);

  return {
    version: parsed ? parsed.raw : rawVersion,
    tag: parsed ? parsed.tag : `v${rawVersion}`,
    isPrerelease: parsed ? parsed.isPrerelease : true,
    lifecycle,
    revisions: {
      gitRevision: validatedSha,
      runtimeSchemaRevision: schemaRevision(snapshot).revision,
      skillRegistryRevision: skillRegistryRevision(skillRegistry),
      sourceRegistryRevision: sourceRegistryRevision(sourceRegistry),
    },
  };
}

module.exports = {
  SEMVER_STRICT_REGEX,
  GIT_SHA_REGEX,
  LIFECYCLE_STATES,
  PROPOSED_DEFAULT_RELEASE_VERSION,
  parseSemVer,
  validateGitSha,
  resolveLifecycle,
  resolveProductVersion,
  getReleaseMetadata,
};
