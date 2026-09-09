'use strict';

// Canonical, deep plan-spec sanitizer shared by the planner context and the
// browser publicView (CONVERSATIONAL_PLAN_FLOW_DESIGN §5b). The nodewise spec is
// credential-free by design, but the conversational flow must GUARANTEE it: a
// structural projection + deep drop of forbidden keys anywhere + a fail-closed
// secret-value scan. Never trust a raw spec by reference.

const FORBIDDEN_KEYS = new Set([
  'credential', 'credentials', 'token', 'tokens', 'secret', 'secrets',
  'password', 'passwd', 'apikey', 'api_key', 'auth', 'authorization',
  'boundname', 'handle', 'accesstoken', 'refreshtoken', 'clientsecret',
]);

// Conservative secret-VALUE patterns (avoid false-positives on prose / public URLs):
// JWTs, bearer tokens, long hex, long continuous base64 blobs.
const SECRET_VALUE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|bearer\s+[A-Za-z0-9._-]{8,}|\b[A-Fa-f0-9]{40,}\b|[A-Za-z0-9+/]{60,}={0,2}/i;

function deepSanitize(value) {
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) continue; // drop forbidden key + subtree
      out[k] = deepSanitize(v);
    }
    return out;
  }
  return value;
}

function assertNoSecrets(value, path) {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) throw new Error(`plan spec contains a secret-shaped value${path ? ` at ${path}` : ''}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path || ''}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) throw new Error(`plan spec contains forbidden key: ${k}`);
      assertNoSecrets(v, path ? `${path}.${k}` : k);
    }
  }
}

function sanitizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  return {
    id: step.id,
    capability: step.capability,
    configuration: deepSanitize(step.configuration || {}),
  };
}

// Structural projection + deep forbidden-key drop + fail-closed value scan.
function sanitizePlanSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const projected = {
    goal: typeof spec.goal === 'string' ? spec.goal : undefined,
    expectedOutput: spec.expectedOutput && typeof spec.expectedOutput === 'object'
      ? { fields: Array.isArray(spec.expectedOutput.fields) ? spec.expectedOutput.fields.filter((f) => typeof f === 'string') : [] }
      : undefined,
    steps: Array.isArray(spec.steps) ? spec.steps.map(sanitizeStep) : [],
  };
  assertNoSecrets(projected); // defense-in-depth: never emit a spec with a secret-shaped value
  return projected;
}

module.exports = { sanitizePlanSpec, assertNoSecrets, deepSanitize, FORBIDDEN_KEYS };
