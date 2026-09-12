'use strict';

// Canonical release metadata adapter.
// Bridges human-readable SemVer (MAJOR.MINOR.PATCH[-PRERELEASE]) with machine-level
// immutable Git SHAs and cryptographic schema/skill revisions.
//
// Invariants:
// 1. Never replaces cryptographic hashes in planBinding HMAC signatures.
// 2. Fallback candidate version is configurable via environment variable `PRODUCT_RELEASE_VERSION`.
// 3. Produces consistent, deterministic metadata for `/health` and `/models`.

const crypto = require('node:crypto');
const runtimeSnapshot = require('../schemas/runtime_node_schemas.json');
const { SKILLS } = require('./runtimeSkillRegistry');
const { schemaRevision } = require('./runtimeSchemaRevision');
const { sourceRegistryRevision } = require('./sourceSchemaRegistry');

// Semantic versioning pattern (SemVer 2.0.0 compliant)
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Candidate default release label proposed for Brain/Dan decision.
// Default candidate label is unpromoted/candidate status until Dan promotes.
const PROPOSED_DEFAULT_RELEASE_VERSION = '0.4.0-rc.1';

function parseSemVer(versionStr) {
  if (typeof versionStr !== 'string') return null;
  const trimmed = versionStr.trim().replace(/^v/i, '');
  if (!SEMVER_REGEX.test(trimmed)) return null;
  const match = trimmed.match(SEMVER_REGEX);
  return {
    raw: trimmed,
    tag: `v${trimmed}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    build: match[5] || null,
    isPrerelease: Boolean(match[4]),
  };
}

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

function getReleaseMetadata({
  env = process.env,
  gitSha = null,
  snapshot = runtimeSnapshot,
  skillRegistry = SKILLS,
  sourceRegistry,
} = {}) {
  const version = resolveProductVersion(env);
  const parsed = parseSemVer(version);
  const effectiveGitSha = gitSha || env.GIT_COMMIT_SHA || env.GIT_SHA || env.REVISION || null;

  return {
    version: parsed ? parsed.raw : version,
    tag: parsed ? parsed.tag : `v${version}`,
    isPrerelease: parsed ? parsed.isPrerelease : true,
    revisions: {
      gitRevision: effectiveGitSha,
      runtimeSchemaRevision: schemaRevision(snapshot).revision,
      skillRegistryRevision: skillRegistryRevision(skillRegistry),
      sourceRegistryRevision: sourceRegistryRevision(sourceRegistry),
    },
  };
}

module.exports = {
  SEMVER_REGEX,
  PROPOSED_DEFAULT_RELEASE_VERSION,
  parseSemVer,
  resolveProductVersion,
  getReleaseMetadata,
};
