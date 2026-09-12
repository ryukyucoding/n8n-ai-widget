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

// Source ref = { kind, reference, cardinality } (nodewiseCompiler source()).
function refObject(o) {
  if (!o || typeof o !== 'object') return undefined;
  const out = {};
  if (scalar(o.kind) !== undefined) out.kind = scalar(o.kind);
  if (scalar(o.reference) !== undefined) out.reference = scalar(o.reference);
  if (scalar(o.cardinality) !== undefined) out.cardinality = scalar(o.cardinality);
  return out;
}

// mappings/objectMappings entries are { from, to, valueType }; renames are
// { from, to } (no valueType). Each reduced to bounded scalars.
function mapList(arr, withValueType) {
  if (!Array.isArray(arr)) return undefined;
  return arr
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const e = {};
      if (scalar(m.from) !== undefined) e.from = scalar(m.from);
      if (scalar(m.to) !== undefined) e.to = scalar(m.to);
      if (withValueType && scalar(m.valueType) !== undefined) e.valueType = scalar(m.valueType);
      return (e.from !== undefined || e.to !== undefined) ? e : null;
    })
    .filter(Boolean);
}

// Allowlist of exactly the configuration keys the nodewise compiler consumes
// (nodewiseCompiler.js validateSpecification). Refs (url/input/objectInput/
// itemsInput) and valueType-bearing mappings are preserved so the plan stays
// recompilable; every other key is dropped.
function setFieldMappingList(arr) {
  if (!Array.isArray(arr)) return undefined;
  return arr.map((mapping) => {
    if (!mapping || typeof mapping !== 'object') return null;
    const out = {};
    if (scalar(mapping.to) !== undefined) out.to = scalar(mapping.to);
    if (scalar(mapping.valueType) !== undefined) out.valueType = scalar(mapping.valueType);
    if (mapping.source && typeof mapping.source === 'object' && !Array.isArray(mapping.source)) {
      const source = { kind: scalar(mapping.source.kind) };
      if (source.kind === 'input_field' && scalar(mapping.source.field) !== undefined) source.field = scalar(mapping.source.field);
      if (source.kind === 'literal' && scalar(mapping.source.value) !== undefined) source.value = scalar(mapping.source.value);
      out.source = source;
    }
    return out.to !== undefined && out.valueType !== undefined && out.source ? out : null;
  }).filter(Boolean).slice(0, 20);
}

function sanitizeConfiguration(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  put('operation', scalar(config.operation));
  put('interval', scalar(config.interval));
  put('intervalValue', scalar(config.intervalValue));
  put('method', scalar(config.method));
  put('url', refObject(config.url));
  put('input', refObject(config.input));
  put('objectInput', refObject(config.objectInput));
  put('itemsInput', refObject(config.itemsInput));
  put('field', scalar(config.field));
  put('totalField', scalar(config.totalField));
  put('falseCountField', scalar(config.falseCountField));
  put('limit', scalar(config.limit));
  put('offset', scalar(config.offset));
  put('keep', scalar(config.keep));
  put('order', scalar(config.order));
  put('mappings', config.operation === 'set_fields' ? setFieldMappingList(config.mappings) : mapList(config.mappings, true));
  put('objectMappings', mapList(config.objectMappings, true));
  put('renames', mapList(config.renames, false));
  return out;
}

// Scrub a raw user message before it reaches the planner/model: replace any
// secret-shaped substring with a placeholder and bound the length. The current
// user turn is NOT covered by context redaction, so it must be scrubbed here.
const SECRET_VALUE_G = new RegExp(SECRET_VALUE.source, 'gi');
function scrubText(str, maxLen = 4000) {
  if (typeof str !== 'string') return { text: '', redacted: false };
  let redacted = false;
  let out = str.replace(SECRET_VALUE_G, () => { redacted = true; return '«redacted»'; });
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return { text: out, redacted };
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

// requiredUserSetup is structural (compiler requires an array, =[] to compile).
// Preserve as a bounded array of plain scalars; non-scalar entries dropped.
function sanitizeSetupList(v) {
  if (!Array.isArray(v)) return undefined;
  return v.map(scalar).filter((x) => x !== undefined).slice(0, 50);
}

function sanitizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const out = {
    id: scalar(step.id),
    capability: scalar(step.capability),
    configuration: sanitizeConfiguration(step.configuration),
  };
  const rus = sanitizeSetupList(step.requiredUserSetup);
  if (rus !== undefined) out.requiredUserSetup = rus;
  return out;
}

// Structural allowlist projection (incl. the canonical IR markers the planner
// needs during multi-turn refinement) + fail-closed value scan.
function sanitizePlanSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const projected = {};
  const put = (k, v) => { if (v !== undefined) projected[k] = v; };
  put('schemaVersion', scalar(spec.schemaVersion));
  put('kind', scalar(spec.kind));
  put('goal', typeof spec.goal === 'string' ? (spec.goal.length > MAX_STR ? spec.goal.slice(0, MAX_STR) : spec.goal) : undefined);
  put('requiredUserSetup', sanitizeSetupList(spec.requiredUserSetup));
  if (spec.expectedOutput && typeof spec.expectedOutput === 'object') {
    const eo = {};
    if (scalar(spec.expectedOutput.deliveryShape) !== undefined) eo.deliveryShape = scalar(spec.expectedOutput.deliveryShape);
    eo.fields = Array.isArray(spec.expectedOutput.fields) ? spec.expectedOutput.fields.filter((f) => typeof f === 'string') : [];
    projected.expectedOutput = eo;
  }
  projected.steps = Array.isArray(spec.steps) ? spec.steps.map(sanitizeStep) : [];
  assertNoSecrets(projected); // defense-in-depth: never emit a spec with a secret-shaped value
  return projected;
}

module.exports = { sanitizePlanSpec, sanitizeConfiguration, assertNoSecrets, scrubText, FORBIDDEN_KEYS };
