'use strict';

// Planner-context allowlist / redaction (CONVERSATIONAL_PLAN_FLOW_DESIGN §5b).
// What is fed into qwen3.8 history / current-plan context must be a strict
// allowlist: ONLY the plan spec (structural) + credential requirements reduced to
// { credentialType, status }. Never credential names/ids/tokens, private
// credential metadata, raw service (e.g. Google) data, or arbitrary prior
// response content. This prevents secrets/private data leaking into the model
// context or being echoed back.

const { sanitizePlanSpec, assertNoSecrets } = require('./planSpecSanitizer');

const ALLOWED_TOP_KEYS = ['planSpec', 'credentialRequirements'];
const ALLOWED_REQ_KEYS = ['credentialType', 'status'];

// Build the redacted context by CONSTRUCTING the allowed shape from input —
// unknown fields are simply never copied (allowlist, not blocklist).
function redactForPlannerContext(input = {}) {
  const planSpec = sanitizePlanSpec(input && input.planSpec); // deep structural projection + secret scan
  const reqs = Array.isArray(input && input.credentialRequirements) ? input.credentialRequirements : [];
  const credentialRequirements = reqs.map((r) => ({
    credentialType: r && r.credentialType,
    status: r && r.status,
  }));
  return { planSpec: planSpec || null, credentialRequirements };
}

// Defense-in-depth guard: throw if a context object carries anything outside the
// allowlist (top-level keys, or forbidden keys inside a requirement).
function assertPlannerContextClean(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('planner context is not clean: not an object');
  for (const key of Object.keys(ctx)) {
    if (!ALLOWED_TOP_KEYS.includes(key)) throw new Error(`planner context has forbidden top-level key: ${key}`);
  }
  for (const r of ctx.credentialRequirements || []) {
    for (const key of Object.keys(r)) {
      if (!ALLOWED_REQ_KEYS.includes(key)) throw new Error(`planner context requirement has forbidden key: ${key}`);
    }
  }
  assertNoSecrets(ctx.planSpec); // deep: no forbidden keys / secret values in the plan spec
  return true;
}

module.exports = { redactForPlannerContext, assertPlannerContextClean, ALLOWED_TOP_KEYS, ALLOWED_REQ_KEYS };
