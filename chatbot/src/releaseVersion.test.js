'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSemVer,
  validateGitSha,
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

test('validateGitSha accepts 7-40 hex chars and rejects invalid formats', () => {
  assert.equal(validateGitSha('b0d258d'), 'b0d258d');
  assert.equal(validateGitSha('B0D258D'), 'b0d258d'); // Lowercases
  assert.equal(validateGitSha('b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23'), 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23');

  // Rejects too short, too long, or non-hex
  assert.equal(validateGitSha('b0d25'), null); // < 7
  assert.equal(validateGitSha('g0d258d'), null); // non-hex 'g'
  assert.equal(validateGitSha('b0d258d'.repeat(10)), null); // > 40
  assert.equal(validateGitSha(null), null);
  assert.equal(validateGitSha(''), null);
});

test('resolveLifecycle derives explicit candidate, stable, or not-live', () => {
  // Explicit environment override
  assert.equal(resolveLifecycle(null, { RELEASE_LIFECYCLE: 'not-live' }), 'not-live');
  assert.equal(resolveLifecycle(null, { RELEASE_LIFECYCLE: 'candidate' }), 'candidate');
  assert.equal(resolveLifecycle(null, { RELEASE_LIFECYCLE: 'stable' }), 'stable');

  // Derived from parsed SemVer
  assert.equal(resolveLifecycle(parseSemVer('0.4.0-rc.1'), {}), 'candidate');
  assert.equal(resolveLifecycle(parseSemVer('0.4.0'), {}), 'stable');
  assert.equal(resolveLifecycle(null, {}), 'not-live');
});

test('resolveProductVersion defaults safely and respects valid overrides', () => {
  assert.equal(resolveProductVersion({}), PROPOSED_DEFAULT_RELEASE_VERSION);
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: '0.4.0-rc.2' }), '0.4.0-rc.2');
  assert.equal(resolveProductVersion({ RELEASE_VERSION: 'v1.0.0' }), '1.0.0');

  // Disallows invalid overrides and falls back safely
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: 'invalid.version' }), PROPOSED_DEFAULT_RELEASE_VERSION);
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: '01.0.0' }), PROPOSED_DEFAULT_RELEASE_VERSION);
});

test('getReleaseMetadata produces structured deterministic metadata', () => {
  const meta = getReleaseMetadata({
    env: {
      PRODUCT_RELEASE_VERSION: '0.4.0-rc.1',
      GIT_COMMIT_SHA: 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23',
    },
  });

  assert.equal(meta.version, '0.4.0-rc.1');
  assert.equal(meta.tag, 'v0.4.0-rc.1');
  assert.equal(meta.isPrerelease, true);
  assert.equal(meta.lifecycle, 'candidate');

  assert.equal(meta.revisions.gitRevision, 'b0d258dbc4dc8a11ccedcf03f526a093e9c2cc23');
  assert.match(meta.revisions.runtimeSchemaRevision, /^unknown\+[a-f0-9]{16}$/);
  assert.match(meta.revisions.skillRegistryRevision, /^[a-f0-9]{64}$/);
  assert.match(meta.revisions.sourceRegistryRevision, /^[a-f0-9]{16}$/);
});

test('getReleaseMetadata safely discards invalid gitRevision in metadata', () => {
  const meta = getReleaseMetadata({
    env: {
      GIT_COMMIT_SHA: 'not-a-valid-sha-token',
    },
  });
  assert.equal(meta.revisions.gitRevision, null);
});
