'use strict';

// Server-side policy gate for credentialed skills. A caller must construct this
// input from trusted deployment/auth state; browser body fields are never valid
// inputs. The solo lane is an explicit private-test exception, not authentication.

const LANES = Object.freeze(['solo', 'public']);

function decision(allowed, lane, code, reason) {
  return { allowed, lane, code: code || null, reason: reason || null };
}

function evaluateCredentialAccess({
  // Omission must fail closed into the public lane; it must never imply solo.
  lane = 'public',
  soloCredentialMode = false,
  runtimeCompilerEnabled = false,
  apiKeyPresent = false,
  privatePerimeterVerified = false,
  callerIdentityVerified = false,
  ownershipScoped = false,
  credentialApiVerified = false,
} = {}) {
  if (!LANES.includes(lane)) {
    return decision(false, lane, 'credential_lane_invalid', 'credential lane is not recognized');
  }
  if (!runtimeCompilerEnabled) {
    return decision(false, lane, 'runtime_compiler_disabled', 'runtime compiler is disabled');
  }
  if (!apiKeyPresent) {
    return decision(false, lane, 'n8n_api_key_missing', 'n8n API access is not configured');
  }

  if (lane === 'solo') {
    if (!soloCredentialMode) {
      return decision(false, lane, 'solo_credential_mode_disabled', 'solo credential mode is disabled');
    }
    if (privatePerimeterVerified !== true) {
      return decision(false, lane, 'private_perimeter_unverified', 'private deployment perimeter is not verified');
    }
    return decision(true, lane, null, null);
  }

  // Public/multi-user credential access needs all three independent facts. A
  // service API key alone does not establish caller identity or ownership.
  if (callerIdentityVerified !== true) {
    return decision(false, lane, 'caller_identity_unverified', 'caller identity is not verified');
  }
  if (ownershipScoped !== true) {
    return decision(false, lane, 'credential_ownership_unverified', 'credential ownership is not scoped');
  }
  if (credentialApiVerified !== true) {
    return decision(false, lane, 'credential_api_unverified', 'credential API behavior is not verified');
  }
  return decision(true, lane, null, null);
}

function assertCredentialAccess(input) {
  const result = evaluateCredentialAccess(input);
  if (!result.allowed) {
    const error = new Error(result.reason);
    error.code = result.code;
    error.lane = result.lane;
    throw error;
  }
  return result;
}

module.exports = { LANES, evaluateCredentialAccess, assertCredentialAccess };
