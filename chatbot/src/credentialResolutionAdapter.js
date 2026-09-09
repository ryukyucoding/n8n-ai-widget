'use strict';

// Credential-resolution adapter for the conversational plan flow (single-user/solo).
// Given required credential TYPES and an injected candidate lister (the real one
// queries n8n server-side and returns SANITIZED candidates; tests inject a mock),
// it decides, per type: 0 -> setup_required; 1 -> ready (auto-bind silently);
// >1 -> needs_choice with a default candidate = most-recently-used, else
// most-recently-created (Dan's rule, CONVERSATIONAL_PLAN_FLOW_DESIGN §2).
//
// It NEVER surfaces anything beyond an opaque `handle` + `displayName` + status —
// no n8n ids, tokens, or secret values reach the caller/browser. The server maps
// handle -> real credential server-side (out of scope here).

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }

// Deterministic default: most-recently-used (finite lastUsedAt) if any used, else
// most-recently-created; ties break by createdAt desc, then handle asc (stable).
// Non-finite/NaN timestamps are treated as absent, never as a winning value.
function pickDefault(candidates) {
  const used = candidates.filter((c) => finite(c.lastUsedAt));
  const usedMode = used.length > 0;
  const pool = usedMode ? used : candidates;
  const primary = (c) => (usedMode ? (finite(c.lastUsedAt) ? c.lastUsedAt : -Infinity) : (finite(c.createdAt) ? c.createdAt : -Infinity));
  const created = (c) => (finite(c.createdAt) ? c.createdAt : -Infinity);
  return [...pool].sort((a, b) => {
    if (primary(b) !== primary(a)) return primary(b) - primary(a);
    if (created(b) !== created(a)) return created(b) - created(a);
    const ha = String(a.handle); const hb = String(b.handle); // locale-independent, deterministic
    return ha < hb ? -1 : (ha > hb ? 1 : 0);
  })[0];
}

function sanitize(candidate) {
  return { handle: candidate.handle, displayName: candidate.displayName };
}

async function resolveCredentialType(credentialType, listCandidates) {
  const raw = (await listCandidates(credentialType)) || [];
  const candidates = raw.map(sanitize);
  if (raw.length === 0) {
    return { credentialType, count: 0, status: 'setup_required', selected: null, default: null, candidates };
  }
  if (raw.length === 1) {
    return { credentialType, count: 1, status: 'ready', selected: raw[0].handle, default: null, candidates };
  }
  const def = pickDefault(raw).handle;
  return { credentialType, count: raw.length, status: 'needs_choice', selected: def, default: def, candidates };
}

// Aggregate over all required types. Overall precedence: any setup_required ->
// setup_required; else any needs_choice -> needs_choice; else ready.
// createDisposition: ready -> bind_and_create; anything else -> create_inactive_draft.
async function resolveCredentialRequirements(requiredTypes, listCandidates) {
  const requirements = [];
  for (const type of requiredTypes) {
    requirements.push(await resolveCredentialType(type, listCandidates));
  }
  let overall = 'ready';
  if (requirements.some((r) => r.status === 'setup_required')) overall = 'setup_required';
  else if (requirements.some((r) => r.status === 'needs_choice')) overall = 'needs_choice';
  return {
    requirements,
    overall,
    createDisposition: overall === 'ready' ? 'bind_and_create' : 'create_inactive_draft',
  };
}

module.exports = { resolveCredentialType, resolveCredentialRequirements, pickDefault };
