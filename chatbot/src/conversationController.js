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

// Status machine (server-side): planning -> ready_to_confirm | awaiting_credential_choice.
function computeStatus(outcome, credentials) {
  if (outcome === 'clarification_required' || outcome === 'unsupported_capability') return 'planning';
  if (credentials && credentials.overall === 'needs_choice') return 'awaiting_credential_choice';
  return 'ready_to_confirm';
}

function createConversationController({ store, redact, plan, resolveCredentials, compileAndCreate }) {
  async function turn(callerId, conversationId, message) {
    const s = store.get(conversationId, callerId);
    if (!s) return { error: 'conversation_not_found' };
    // Planner only ever sees a redacted context (no credential names/ids/secrets/raw data).
    const redactedContext = redact({
      planSpec: s.planSpec,
      credentialRequirements: (s.credentials && s.credentials.requirements) || [],
    });
    const result = await plan({ message, previousSpec: s.planSpec, redactedContext });
    const spec = result.spec || s.planSpec;
    let credentials = s.credentials;
    if (result.spec) credentials = await resolveCredentials(result.spec);
    const status = computeStatus(result.outcome, credentials);
    store.update(conversationId, callerId, {
      planSpec: spec,
      credentials,
      status,
      history: [...s.history, { role: 'user' }, { role: 'assistant' }],
    });
    return {
      conversationId,
      outcome: result.outcome,
      assistantMessage: result.assistantMessage,
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
    // Authoritative compile uses the FULL server-side spec, never the sanitized view.
    const result = await compileAndCreate(s.planSpec);
    store.update(conversationId, callerId, { status: result.status === 200 ? 'done' : 'planning' });
    return { conversationId, result, view: store.publicView(conversationId, callerId) };
  }

  return { start, respond, cancel, confirm };
}

module.exports = { createConversationController, computeStatus };
