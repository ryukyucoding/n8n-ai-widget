'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSemVer,
  resolveProductVersion,
  getReleaseMetadata,
  PROPOSED_DEFAULT_RELEASE_VERSION,
} = require('./releaseVersion');

test('parseSemVer validates and decomposes compliant SemVer strings', () => {
  const parsed = parseSemVer('0.4.0');
  assert.equal(parsed.major, 0);
  assert.equal(parsed.minor, 4);
  assert.equal(parsed.patch, 0);
  assert.equal(parsed.isPrerelease, false);
  assert.equal(parsed.tag, 'v0.4.0');

  const rc = parseSemVer('v0.4.0-rc.1');
  assert.equal(rc.raw, '0.4.0-rc.1');
  assert.equal(rc.prerelease, 'rc.1');
  assert.equal(rc.isPrerelease, true);
  assert.equal(rc.tag, 'v0.4.0-rc.1');

  // Invalid versions return null
  assert.equal(parseSemVer('invalid.version'), null);
  assert.equal(parseSemVer('1.0'), null);
  assert.equal(parseSemVer(null), null);
  assert.equal(parseSemVer(''), null);
});

test('resolveProductVersion defaults to proposed candidate version when unconfigured', () => {
  assert.equal(resolveProductVersion({}), PROPOSED_DEFAULT_RELEASE_VERSION);
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: '' }), PROPOSED_DEFAULT_RELEASE_VERSION);
});

test('resolveProductVersion respects valid environment override', () => {
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: '0.4.0-rc.2' }), '0.4.0-rc.2');
  assert.equal(resolveProductVersion({ RELEASE_VERSION: 'v1.0.0' }), '1.0.0');

  // Falls back to proposed default if override is malformed
  assert.equal(resolveProductVersion({ PRODUCT_RELEASE_VERSION: 'not-a-semver' }), PROPOSED_DEFAULT_RELEASE_VERSION);
});

test('getReleaseMetadata produces deterministic version and preserves all cryptographic revisions', () => {
  const meta = getReleaseMetadata({
    env: { PRODUCT_RELEASE_VERSION: '0.4.0-rc.1', GIT_COMMIT_SHA: 'b0d258d' },
  });

  assert.equal(meta.version, '0.4.0-rc.1');
  assert.equal(meta.tag, 'v0.4.0-rc.1');
  assert.equal(meta.isPrerelease, true);

  // Verifies all 4 revision dimensions are present and non-empty
  assert.equal(meta.revisions.gitRevision, 'b0d258d');
  assert.match(meta.revisions.runtimeSchemaRevision, /^unknown\+[a-f0-9]{16}$/);
  assert.match(meta.revisions.skillRegistryRevision, /^[a-f0-9]{64}$/);
  assert.match(meta.revisions.sourceRegistryRevision, /^[a-f0-9]{16}$/);
});

test('getReleaseMetadata allows explicit stable version without prerelease flag', () => {
  const meta = getReleaseMetadata({
    env: { PRODUCT_RELEASE_VERSION: '0.4.0' },
  });
  assert.equal(meta.version, '0.4.0');
  assert.equal(meta.isPrerelease, false);
});
