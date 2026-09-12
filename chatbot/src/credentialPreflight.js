'use strict';

// Pure fake-only validator/classifier for credential_preflight/v1. It consumes
// already-sanitized facts supplied by a trusted test/operator adapter. It does
// not inspect the network, n8n, credentials, browser headers, or deployment.
// `solo_test_ready` means only that the private Dan-controlled test perimeter is
// ready for inactive-draft-only testing; it never means credential API/binding
// runtime access is ready. Unknown API facts remain in actionsRequired.

const STATUSES = new Set(['blocked', 'solo_test_ready', 'multi_user_ready']);
const PERIMETER_STATUSES = new Set(['verified_private', 'verified_authenticated', 'public_or_unknown']);
const AUTH_STATUSES = new Set(['verified', 'not_required_for_solo', 'unknown', 'failed']);
const AUTH_METHODS = new Set(['server_session', 'trusted_proxy', 'n8n_identity_reuse', 'none']);
const API_STATUSES = new Set(['verified', 'unknown', 'failed']);
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const SECRET_SHAPED = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|\bbearer\s+[A-Za-z0-9._-]{8,}\b|\b(?:sk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{8,}\b|\b[A-Fa-f0-9]{40,}\b/i;
const MAX_TEXT = 256;

function safeText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT || SECRET_SHAPED.test(value)) return null;
  if (/https?:\/\/|[\\\r\n]|^(?:[A-Za-z]:|\/)/i.test(value.trim())) return null;
  return value.trim();
}

function safeRefs(refs) {
  return Array.isArray(refs) && refs.length <= 50
    && refs.every((ref) => typeof ref === 'string' && EVIDENCE_REF.test(ref) && !ref.includes('..') && !SECRET_SHAPED.test(ref));
}

function result(status, perimeter, callerAuth, credentialApi, actionsRequired, assumptionsRejected) {
  return {
    schema: 'credential_preflight/v1', status, perimeter, callerAuth, credentialApi,
    actionsRequired, assumptionsRejected,
  };
}

function evaluateCredentialPreflight({
  perimeter = {},
  callerAuth = {},
  credentialApi = {},
  singleOperatorConfirmed = false,
} = {}) {
  const p = {
    status: PERIMETER_STATUSES.has(perimeter.status) ? perimeter.status : 'public_or_unknown',
    evidenceRefs: safeRefs(perimeter.evidenceRefs) ? [...perimeter.evidenceRefs] : [],
  };
  const a = {
    status: AUTH_STATUSES.has(callerAuth.status) ? callerAuth.status : 'unknown',
    method: AUTH_METHODS.has(callerAuth.method) ? callerAuth.method : 'none',
  };
  const c = {
    status: API_STATUSES.has(credentialApi.status) ? credentialApi.status : 'unknown',
    readCapability: API_STATUSES.has(credentialApi.readCapability) ? credentialApi.readCapability : 'unknown',
    ownershipScope: API_STATUSES.has(credentialApi.ownershipScope) ? credentialApi.ownershipScope : 'unknown',
  };
  const actions = [];
  const rejected = [];
  if (!p.evidenceRefs.length) rejected.push('private perimeter lacks sanitized evidence');
  if (p.status === 'public_or_unknown') rejected.push('public or unknown perimeter');
  if (c.status !== 'verified') actions.push('verify n8n credential API capability');
  if (c.ownershipScope !== 'verified') actions.push('verify credential ownership scope');

  if (p.status === 'verified_private' && p.evidenceRefs.length > 0 && singleOperatorConfirmed
    && c.status !== 'failed' && c.readCapability !== 'failed' && c.ownershipScope !== 'failed') {
    a.status = 'not_required_for_solo';
    a.method = 'none';
    return result('solo_test_ready', p, a, c, actions, rejected);
  }

  const multiReady = p.status === 'verified_authenticated'
    && a.status === 'verified'
    && a.method !== 'none'
    && c.status === 'verified'
    && c.readCapability === 'verified'
    && c.ownershipScope === 'verified';
  if (multiReady) return result('multi_user_ready', p, a, c, actions, rejected);

  if (p.status !== 'verified_private' && p.status !== 'verified_authenticated') {
    actions.push('verify a private or authenticated perimeter');
  }
  if (!singleOperatorConfirmed && p.status === 'verified_private') {
    actions.push('confirm the service is Dan-controlled and single-operator');
  }
  if (a.status !== 'verified' && p.status === 'verified_authenticated') {
    actions.push('verify caller identity through a trusted server adapter');
  }
  return result('blocked', p, a, c, [...new Set(actions)], [...new Set(rejected)]);
}

function validatePreflightResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('preflight result must be an object');
  const topKeys = ['schema', 'status', 'perimeter', 'callerAuth', 'credentialApi', 'actionsRequired', 'assumptionsRejected'];
  if (Object.keys(value).some((key) => !topKeys.includes(key))) throw new Error('preflight result has forbidden field');
  if (value.schema !== 'credential_preflight/v1' || !STATUSES.has(value.status)) throw new Error('preflight schema or status is invalid');
  if (!value.perimeter || !PERIMETER_STATUSES.has(value.perimeter.status) || !safeRefs(value.perimeter.evidenceRefs)) throw new Error('perimeter facts are invalid');
  if (!value.callerAuth || !AUTH_STATUSES.has(value.callerAuth.status) || !AUTH_METHODS.has(value.callerAuth.method)) throw new Error('caller auth facts are invalid');
  if (!value.credentialApi || !API_STATUSES.has(value.credentialApi.status)
    || !API_STATUSES.has(value.credentialApi.readCapability) || !API_STATUSES.has(value.credentialApi.ownershipScope)) throw new Error('credential API facts are invalid');
  for (const list of [value.actionsRequired, value.assumptionsRejected]) {
    if (!Array.isArray(list) || list.length > 50 || list.some((item) => !safeText(item))) throw new Error('preflight disclosure list is invalid');
  }
  // A public result can never claim readiness, regardless of what its caller says.
  if (value.perimeter.status === 'public_or_unknown' && value.status !== 'blocked') throw new Error('public perimeter cannot be ready');
  if (value.status === 'multi_user_ready' && (value.callerAuth.status !== 'verified' || value.credentialApi.ownershipScope !== 'verified')) {
    throw new Error('multi-user readiness lacks identity or ownership');
  }
  if (value.status === 'solo_test_ready' && value.perimeter.status !== 'verified_private') throw new Error('solo readiness requires private perimeter');
  return true;
}

module.exports = { STATUSES, evaluateCredentialPreflight, validatePreflightResult, safeRefs };
