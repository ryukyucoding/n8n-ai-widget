'use strict';

// Canonical, deep plan-spec sanitizer shared by the planner context and the
// browser publicView (CONVERSATIONAL_PLAN_FLOW_DESIGN §5b). This is an ALLOWLIST,
// not a denylist: only structural fields the nodewise compiler actually reads are
// projected; every other key (query/filter/value/description/credentials/…) is
// dropped, so private/PII/credential-like data under innocuous keys cannot reach
// qwen or the browser. Scalars are bounded; a fail-closed secret-value scan runs
// on the projection. New skills that add config keys must extend ALLOWED_* here
// (fail-safe: unknown keys drop until explicitly allowed).

const FORBIDDEN_KEYS = new Set([
  'credential', 'credentials', 'token', 'tokens', 'secret', 'secrets',
  'password', 'passwd', 'apikey', 'api_key', 'auth', 'authorization',
  'boundname', 'handle', 'accesstoken', 'refreshtoken', 'clientsecret',
]);

const SECRET_VALUE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|bearer\s+[A-Za-z0-9._-]{8,}|\b[A-Fa-f0-9]{40,}\b|[A-Za-z0-9+/]{60,}={0,2}/i;
const MAX_STR = 512;

function scalar(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  return undefined; // drop objects/arrays/functions where a scalar is expected
}

// {from,to} pairs (mappings/renames/objectMappings) — the only structured config
// lists the compiler reads; each entry reduced to bounded from/to scalars.
function fromToList(arr) {
  if (!Array.isArray(arr)) return undefined;
  return arr
    .map((m) => (m && typeof m === 'object' ? { from: scalar(m.from), to: scalar(m.to) } : null))
    .filter((m) => m && (m.from !== undefined || m.to !== undefined));
}

function refObject(o) {
  if (!o || typeof o !== 'object') return undefined;
  const out = {};
  if (scalar(o.reference) !== undefined) out.reference = scalar(o.reference);
  if (scalar(o.cardinality) !== undefined) out.cardinality = scalar(o.cardinality);
  return out;
}

// Allowlist of configuration keys the nodewise compiler actually consumes
// (nodewiseCompiler.js). Anything else is dropped.
function sanitizeConfiguration(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  put('operation', scalar(config.operation));
  put('url', refObject(config.url));
  put('objectInput', refObject(config.objectInput));
  put('field', scalar(config.field));
  put('totalField', scalar(config.totalField));
  put('falseCountField', scalar(config.falseCountField));
  put('limit', scalar(config.limit));
  put('offset', scalar(config.offset));
  put('keep', scalar(config.keep));
  put('order', scalar(config.order));
  put('mappings', fromToList(config.mappings));
  put('renames', fromToList(config.renames));
  put('objectMappings', fromToList(config.objectMappings));
  return out;
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
    id: scalar(step.id),
    capability: scalar(step.capability),
    configuration: sanitizeConfiguration(step.configuration),
  };
}

// Structural allowlist projection + fail-closed value scan.
function sanitizePlanSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const projected = {
    goal: typeof spec.goal === 'string' ? (spec.goal.length > MAX_STR ? spec.goal.slice(0, MAX_STR) : spec.goal) : undefined,
    expectedOutput: spec.expectedOutput && typeof spec.expectedOutput === 'object'
      ? { fields: Array.isArray(spec.expectedOutput.fields) ? spec.expectedOutput.fields.filter((f) => typeof f === 'string') : [] }
      : undefined,
    steps: Array.isArray(spec.steps) ? spec.steps.map(sanitizeStep) : [],
  };
  assertNoSecrets(projected); // defense-in-depth: never emit a spec with a secret-shaped value
  return projected;
}

module.exports = { sanitizePlanSpec, sanitizeConfiguration, assertNoSecrets, FORBIDDEN_KEYS };
