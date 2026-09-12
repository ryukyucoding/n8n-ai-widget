'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSemVer,
  classifyGitSha,
  resolveLifecycle,
  resolveProductVersion,
  getReleaseMetadata,
  PROPOSED_DEFAULT_RELEASE_VERSION,
} = require('./releaseVersion');

test('parseSemVer validates compliant SemVer and rejects leading zeros', () => {
  const v = parseSemVer('1.2.3');
  assert.equal(v.major, '1');
  assert.equal(v.minor, '2');
  assert.equal(v.patch, '3');
  assert.equal(v.majorNumber, 1);
  assert.equal(v.isPrerelease, false);
  assert.equal(v.tag, 'v1.2.3');

  // Disallows leading zeros (SemVer 2.0.0 §2)
  assert.equal(parseSemVer('01.2.3'), null);
  assert.equal(parseSemVer('1.02.3'), null);
  assert.equal(parseSemVer('1.2.03'), null);
  assert.equal(parseSemVer('00.0.0'), null);

  // '0.0.0' is valid
  assert.notEqual(parseSemVer('0.0.0'), null);
});

test('parseSemVer handles internal whitespace and excessive length safely', () => {
  // Rejects internal whitespace
  assert.equal(parseSemVer('1. 2. 3'), null);
  assert.equal(parseSemVer('1.2.3 -rc.1'), null);
  assert.equal(parseSemVer('v 1.2.3'), null);

  // Rejects excessively long input strings
  assert.equal(parseSemVer('1.0.0-' + 'a'.repeat(200)), null);
});

test('parseSemVer preserves string precision for huge numeric components', () => {
  const huge = '90071992547409999999999999999'; // Exceeds Number.MAX_SAFE_INTEGER
  const v = parseSemVer(`${huge}.1.0`);
  assert.notEqual(v, null);
  assert.equal(v.major, huge);
  assert.equal(v.majorNumber, null); // Gracefully avoids IEEE-754 precision distortion
});

test('classifyGitSha strictly distinguishes 40-hex release provenance from short diagnostic SHA', () => {
  const full40 = 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
  const classifiedFull = classifyGitSha(full40);
  assert.equal(classifiedFull.sha, full40);
  assert.equal(classifiedFull.grade, 'full');

  const short7 = 'b0d258d';
  const classifiedShort = classifyGitSha(short7);
  assert.equal(classifiedShort.sha, 'b0d258d');
  assert.equal(classifiedShort.grade, 'diagnostic');

  // Case insensitivity
  assert.equal(classifyGitSha('B0D258D').sha, 'b0d258d');

  // Rejects invalid formats
  assert.equal(classifyGitSha('b0d25').sha, null); // < 7
  assert.equal(classifyGitSha('g0d258d').sha, null); // non-hex
  assert.equal(classifyGitSha(full40 + 'a').sha, null); // > 40
  assert.equal(classifyGitSha(null).sha, null);
  assert.equal(classifyGitSha('').sha, null);
});

test('resolveLifecycle derives explicit states and forbids stable override on prerelease', () => {
  const rc = parseSemVer('0.4.0-rc.1');

  // Explicit 'stable' override on a prerelease version is blocked (fail-closed)
  assert.equal(resolveLifecycle(rc, { RELEASE_LIFECYCLE: 'stable' }), 'candidate');

  // Prerelease version naturally resolves to candidate
  assert.equal(resolveLifecycle(rc, {}), 'candidate');

  // Stable version resolves to stable, or explicit override
  const stable = parseSemVer('0.4.0');
  assert.equal(resolveLifecycle(stable, {}), 'stable');
  assert.equal(resolveLifecycle(stable, { RELEASE_LIFECYCLE: 'candidate' }), 'candidate');
  assert.equal(resolveLifecycle(stable, { RELEASE_LIFECYCLE: 'not-live' }), 'not-live');
  assert.equal(resolveLifecycle(null, {}), 'not-live');
});

test('resolveProductVersion fails closed on explicit malformed input', () => {
  // When unconfigured, returns default candidate version
  assert.equal(resolveProductVersion({}), PROPOSED_DEFAULT_RELEASE_VERSION);

  // Valid environment overrides succeed
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: '0.4.0-rc.2' }), '0.4.0-rc.2');
  assert.equal(resolveProductVersion({ RELEASE_VERSION: 'v1.0.0' }), '1.0.0');

  // Explicit malformed PRODUCT_RELEASE_VERSION must throw error (fail-closed), never silent fallback
  assert.throws(
    () => resolveProductVersion({ PRODUCT_RELEASE_VERSION: 'invalid-semver' }),
    (err) => err.code === 'invalid_product_release_version' || /Invalid PRODUCT_RELEASE_VERSION/.test(err.message),
  );
  assert.throws(
    () => resolveProductVersion({ PRODUCT_RELEASE_VERSION: '01.0.0' }), // Leading zero
    (err) => err.code === 'invalid_product_release_version' || /Invalid PRODUCT_RELEASE_VERSION/.test(err.message),
  );

  // Explicit malformed RELEASE_VERSION must throw error
  assert.throws(
    () => resolveProductVersion({ RELEASE_VERSION: 'not.a.version' }),
    (err) => err.code === 'invalid_release_version' || /Invalid RELEASE_VERSION/.test(err.message),
  );

  // Empty string does not throw, safely falls through
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: '', RELEASE_VERSION: 'v1.0.0' }), '1.0.0');
});

test('getReleaseMetadata produces structured deterministic metadata with SHA grade', () => {
  const fullSha = 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23';
  const meta = getReleaseMetadata({
    env: {
      PRODUCT_RELEASE_VERSION: '0.4.0-rc.1',
      GIT_COMMIT_SHA: fullSha,
    },
  });

  assert.equal(meta.version, '0.4.0-rc.1');
  assert.equal(meta.tag, 'v0.4.0-rc.1');
  assert.equal(meta.isPrerelease, true);
  assert.equal(meta.lifecycle, 'candidate');

  assert.equal(meta.revisions.gitRevision, fullSha);
  assert.equal(meta.revisions.gitRevisionGrade, 'full');
  assert.match(meta.revisions.runtimeSchemaRevision, /^unknown\+[a-f0-9]{16}$/);
  assert.match(meta.revisions.skillRegistryRevision, /^[a-f0-9]{64}$/);
  assert.match(meta.revisions.sourceRegistryRevision, /^[a-f0-9]{16}$/);
});

test('getReleaseMetadata tags short SHA as diagnostic grade', () => {
  const meta = getReleaseMetadata({
    env: {
      PRODUCT_RELEASE_VERSION: '0.4.0-rc.1',
      GIT_COMMIT_SHA: 'b0d258d',
    },
  });
  assert.equal(meta.revisions.gitRevision, 'b0d258d');
  assert.equal(meta.revisions.gitRevisionGrade, 'diagnostic');
});

test('getReleaseMetadata safely discards invalid gitRevision in metadata', () => {
  const meta = getReleaseMetadata({
    env: {
      GIT_COMMIT_SHA: 'not-a-valid-sha-token',
    },
  });
  assert.equal(meta.revisions.gitRevision, null);
  assert.equal(meta.revisions.gitRevisionGrade, null);
});
