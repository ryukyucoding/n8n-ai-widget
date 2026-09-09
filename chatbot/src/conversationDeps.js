'use strict';

// Stage-3b dependency adapters that bind the conversation controller to the real
// nodewise planner/compiler — kept as small, testable factories. The credential
// resolver here is an explicit STUB (setup_required) until the target n8n
// credentials API is verified (no invented probe/bind endpoint, no real credential).

// Map a reviewNodewisePlannerResult envelope to the controller's plan contract:
// { outcome, spec, assistantMessage }. `reviewFromMessage(message, previousSpec)`
// runs the live nodewise planner + review (injected).
function createPlannerAdapter(reviewFromMessage) {
  return async function plan({ message, previousSpec }) {
    const review = await reviewFromMessage(message, previousSpec);
    if (!review || review.outcome === 'clarification_required') {
      const needs = (review && review.requiredUserInputs) || [];
      return {
        outcome: 'clarification_required',
        spec: null,
        assistantMessage: needs.length ? `需要更多資訊：${needs.join('、')}` : ((review && review.goal) ? `請補充：${review.goal}` : '請提供更明確的需求。'),
      };
    }
    if (review.outcome === 'unsupported_capability') {
      const gaps = (review.capabilityGaps || []).join('、');
      return {
        outcome: 'unsupported_capability',
        spec: null,
        assistantMessage: `目前不支援此需求${gaps ? `：${gaps}` : ''}。系統只用已驗證的技能組合，不會硬生一個跑不動的 workflow。`,
      };
    }
    // ready_to_compile
    const spec = review.specification || null;
    const steps = ((review.plan && review.plan.steps) || (spec && spec.steps) || []).length;
    const goal = (review.plan && review.plan.goal) || (spec && spec.goal) || '';
    return {
      outcome: 'ready_to_compile',
      spec,
      assistantMessage: `已規劃：${goal}（${steps} 步）。確認即可建立，或繼續告訴我要調整的地方。`,
    };
  };
}

// STUB credential resolver: derives required credential TYPES from the spec via the
// injected `requiredTypesForSpec` (currently no credentialed nodewise skill, so it
// returns []), and reports setup_required for any type — it does NOT probe n8n or
// auto-bind. Replaced in stage-4 by the real resolver once the n8n credentials API
// (candidate listing + ownership) is verified. Named to make the stub obvious.
function createSetupRequiredResolver(requiredTypesForSpec) {
  return async function resolveCredentials(spec) {
    const types = (requiredTypesForSpec(spec) || []).filter((t) => typeof t === 'string');
    if (types.length === 0) {
      return { requirements: [], overall: 'ready', createDisposition: 'bind_and_create' };
    }
    return {
      requirements: types.map((t) => ({ credentialType: t, status: 'setup_required', selected: null })),
      overall: 'setup_required',
      createDisposition: 'create_inactive_draft',
    };
  };
}

module.exports = { createPlannerAdapter, createSetupRequiredResolver };
