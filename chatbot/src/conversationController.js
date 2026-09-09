'use strict';

// Orchestrates the conversational plan flow (CONVERSATIONAL_PLAN_FLOW_DESIGN)
// using the stage-2 cores. ALL external effects are injected so it is unit-testable
// without n8n or a live model, and the planner is ALWAYS fed a redacted context.
//
// Injected deps:
//   store               : conversationState store (caller-bound, TTL, publicView)
//   redact(input)       : plannerContextRedaction.redactForPlannerContext
//   plan({ message, previousSpec, redactedContext })
//        -> { outcome, spec, assistantMessage }
//        outcome ∈ 'ready_to_compile' | 'clarification_required' | 'unsupported_capability'
//        spec = full canonical nodewise spec (server-side authority) or null
//   resolveCredentials(spec) -> { requirements, overall, createDisposition }
//        overall ∈ 'ready' | 'needs_choice' | 'setup_required'
//   compileAndCreate(spec)   -> { status, payload }  (authoritative: full server-side spec)

const { scrubText, sanitizePlanSpec, assertNoSecrets } = require('./planSpecSanitizer');

// Status machine (server-side): planning -> ready_to_confirm | awaiting_credential_choice.
// A non-null valid spec is REQUIRED for ready_to_confirm. Credential overall is an
// explicit allowlist — only 'ready' (bind) or 'setup_required' (inactive draft) are
// confirmable; 'needs_choice' awaits a choice; anything else (stale/unknown) FAILS
// CLOSED to planning.
function computeStatus(outcome, credentials, hasSpec) {
  if (!hasSpec) return 'planning';
  if (outcome === 'clarification_required' || outcome === 'unsupported_capability') return 'planning';
  const overall = credentials && credentials.overall;
  if (overall === 'needs_choice') return 'awaiting_credential_choice';
  if (overall === 'ready' || overall === 'setup_required') return 'ready_to_confirm';
  return 'planning'; // fail-closed: stale/unknown/missing credential state is never confirmable
}

// validatePlanSpec is optional (real wiring injects the compiler's validateSpecification
// for canonical structural validation); assertNoSecrets is always enforced here.
function createConversationController({ store, redact, plan, resolveCredentials, compileAndCreate, validatePlanSpec }) {
  async function turn(callerId, conversationId, message) {
    const s = store.get(conversationId, callerId);
    if (!s) return { error: 'conversation_not_found' };
    // The current user turn is NOT covered by context redaction — scrub it here so
    // a pasted token/secret never reaches qwen.
    const { text: safeMessage, redacted } = scrubText(message);
    // Refinement context is EXPLICITLY previousSpec (the memoized plan state) + the
    // latest scrubbed message; raw dialogue history is not replayed to the model.
    const redactedContext = redact({
      planSpec: s.planSpec,
      credentialRequirements: (s.credentials && s.credentials.requirements) || [],
    });
    // The planner NEVER receives the raw server spec — only the sanitized projection,
    // so a planner implementation cannot forward unredacted state to qwen.
    const result = await plan({ message: safeMessage, previousSpec: sanitizePlanSpec(s.planSpec), redactedContext });
    // Model output is untrusted: reject any spec carrying a secret/forbidden field or
    // failing canonical validation BEFORE it is stored / resolved / compiled.
    if (result.spec) {
      try {
        assertNoSecrets(result.spec);
        if (typeof validatePlanSpec === 'function') validatePlanSpec(result.spec);
      } catch (err) {
        store.update(conversationId, callerId, { status: computeStatus('clarification_required', s.credentials, Boolean(s.planSpec)), history: [...s.history, { role: 'user', inputRedacted: redacted }, { role: 'assistant', rejected: true }] });
        return { conversationId, outcome: 'unsafe_plan_rejected', assistantMessage: '這個計畫無法使用（內容不合規或無法驗證），請換個說法再試。', inputRedacted: redacted, view: store.publicView(conversationId, callerId) };
      }
    }
    const spec = result.spec || s.planSpec;
    let credentials = s.credentials;
    if (result.spec) credentials = await resolveCredentials(result.spec);
    const status = computeStatus(result.outcome, credentials, Boolean(spec));
    store.update(conversationId, callerId, {
      planSpec: spec,
      credentials,
      status,
      // history is an audit trail of turns only (role + input-redaction flag); it is
      // NOT fed back to the planner (see context contract above).
      history: [...s.history, { role: 'user', inputRedacted: redacted }, { role: 'assistant' }],
    });
    return {
      conversationId,
      outcome: result.outcome,
      assistantMessage: result.assistantMessage,
      inputRedacted: redacted,
      view: store.publicView(conversationId, callerId),
    };
  }

  async function start(callerId, message) {
    const { conversationId } = store.create(callerId); // throws on empty caller
    return turn(callerId, conversationId, message);
  }

  async function respond(callerId, conversationId, message) {
    if (!store.get(conversationId, callerId)) return { error: 'conversation_not_found' };
    return turn(callerId, conversationId, message);
  }

  function cancel(callerId, conversationId) {
    if (!store.get(conversationId, callerId)) return { error: 'conversation_not_found' };
    store.cancel(conversationId, callerId); // back to planning, keeps plan + history
    return { conversationId, view: store.publicView(conversationId, callerId) };
  }

  async function confirm(callerId, conversationId) {
    const s = store.get(conversationId, callerId);
    if (!s) return { error: 'conversation_not_found' };
    if (s.status !== 'ready_to_confirm') return { error: 'not_ready_to_confirm', status: s.status };
    if (!s.planSpec) return { error: 'no_plan' };
    // RE-RESOLVE credentials at confirm time against the current server-side state:
    // a binding may have changed / been deleted (stale) or become ambiguous since
    // planning. Reject if a choice is now required; otherwise bind the CURRENT
    // resolution. This never trusts the plan-time credential snapshot.
    const resolution = await resolveCredentials(s.planSpec);
    if (resolution.overall === 'needs_choice') {
      store.update(conversationId, callerId, { credentials: resolution, status: 'awaiting_credential_choice' });
      return { error: 'credential_choice_required', view: store.publicView(conversationId, callerId) };
    }
    // Fail-closed: only a fresh ready/setup_required resolution may create; stale/unknown blocks.
    if (resolution.overall !== 'ready' && resolution.overall !== 'setup_required') {
      store.update(conversationId, callerId, { credentials: resolution, status: 'planning' });
      return { error: 'credential_unresolved', overall: resolution.overall, view: store.publicView(conversationId, callerId) };
    }
    // Authoritative compile uses the FULL server-side spec (never the sanitized view)
    // + the freshly-resolved credential binding.
    const result = await compileAndCreate(s.planSpec, resolution);
    store.update(conversationId, callerId, { credentials: resolution, status: result.status === 200 ? 'done' : 'planning' });
    return { conversationId, result, view: store.publicView(conversationId, callerId) };
  }

  return { start, respond, cancel, confirm };
}

module.exports = { createConversationController, computeStatus };
