'use strict';

// Server-side deployment assertion only. This module intentionally has no
// request/body input: browser claims cannot establish a private perimeter.
const PRIVATE_PERIMETER_ENV = 'PRIVATE_PERIMETER_VERIFIED';

function readPrivatePerimeterAssertion(env = process.env) {
  const verified = Boolean(env && env[PRIVATE_PERIMETER_ENV] === 'true');
  return {
    verified,
    source: verified ? 'trusted_deployment_config' : 'unset_or_false',
  };
}

function withPrivatePerimeterAssertion(policy = {}, env = process.env) {
  const assertion = readPrivatePerimeterAssertion(env);
  return { ...policy, privatePerimeterVerified: assertion.verified };
}

module.exports = { PRIVATE_PERIMETER_ENV, readPrivatePerimeterAssertion, withPrivatePerimeterAssertion };
