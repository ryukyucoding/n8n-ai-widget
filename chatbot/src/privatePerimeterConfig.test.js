'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readPrivatePerimeterAssertion, withPrivatePerimeterAssertion } = require('./privatePerimeterConfig');

test('perimeter assertion defaults false when deployment input is absent', () => {
  assert.deepEqual(readPrivatePerimeterAssertion({}), { verified: false, source: 'unset_or_false' });
});

test('only exact server deployment value enables the assertion', () => {
  for (const value of [undefined, '', '1', 'yes', true, 'TRUE', 'false']) {
    assert.equal(readPrivatePerimeterAssertion({ PRIVATE_PERIMETER_VERIFIED: value }).verified, false);
  }
  assert.deepEqual(readPrivatePerimeterAssertion({ PRIVATE_PERIMETER_VERIFIED: 'true' }), { verified: true, source: 'trusted_deployment_config' });
});

test('policy helper overrides any caller-provided perimeter claim', () => {
  const policy = withPrivatePerimeterAssertion({ lane: 'solo', privatePerimeterVerified: true }, {});
  assert.equal(policy.privatePerimeterVerified, false);
  const trusted = withPrivatePerimeterAssertion({ lane: 'solo', privatePerimeterVerified: false }, { PRIVATE_PERIMETER_VERIFIED: 'true' });
  assert.equal(trusted.privatePerimeterVerified, true);
});
