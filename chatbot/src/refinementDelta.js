'use strict';

// Bounded deterministic edits for short conversational refinements. These edits
// are intentionally narrow: a delta is applied only when exactly one compatible
// operation already exists in the prior canonical specification. Unmatched or
// ambiguous requests remain model/planner work and never invent a new step.

const SORT_ORDER_PATTERNS = [
  { order: 'descending', pattern: /^(?:改(?:成|為|为)降序|sort\s+descending|change\s+(?:the\s+)?sort(?:ing)?(?:\s+order)?\s+to\s+descending)\.?$/i },
  { order: 'ascending', pattern: /^(?:改(?:成|為|为)升序|sort\s+ascending|change\s+(?:the\s+)?sort(?:ing)?(?:\s+order)?\s+to\s+ascending)\.?$/i },
];
const LIMIT_PATTERNS = [
  /^(?:改(?:成|為|为)前\s*(\d+)\s*筆|change\s+(?:the\s+)?limit\s+to\s+(\d+))\.?$/i,
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function operationOf(step) {
  return step && step.configuration && step.configuration.operation;
}

function compatibleSteps(specification, operation) {
  return (Array.isArray(specification && specification.steps) ? specification.steps : [])
    .filter((step) => operationOf(step) === operation);
}

function patchSingleOperation(specification, operation, patch, { requiresField = false } = {}) {
  const matches = compatibleSteps(specification, operation);
  if (matches.length !== 1) {
    return { matched: false, recognized: true, reason: matches.length === 0 ? 'target_missing' : 'target_ambiguous', operation };
  }
  const target = matches[0];
  const configuration = target.configuration || {};
  const input = configuration.input;
  const hasField = typeof configuration.field === 'string' && configuration.field.trim() !== '';
  if (!input || input.cardinality !== 'items' || (requiresField && !hasField)) {
    return { matched: false, recognized: true, reason: 'target_invalid', operation };
  }
  const next = clone(specification);
  const nextStep = next.steps.find((step) => step && step.id === target.id);
  Object.assign(nextStep.configuration, patch);
  return { matched: true, recognized: true, operation, specification: next };
}

function applyRefinementDelta(previousSpecification, message) {
  if (!previousSpecification || typeof previousSpecification !== 'object') return { matched: false, recognized: false, reason: 'no_previous_specification' };
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return { matched: false, recognized: false, reason: 'empty_message' };

  for (const { order, pattern } of SORT_ORDER_PATTERNS) {
    if (pattern.test(text)) return patchSingleOperation(previousSpecification, 'sort_items', { order }, { requiresField: true });
  }
  for (const pattern of LIMIT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const rawLimit = match[1] || match[2];
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return { matched: false, recognized: true, reason: 'limit_out_of_bounds', operation: 'limit_items' };
    }
    return patchSingleOperation(previousSpecification, 'limit_items', { limit });
  }

  return { matched: false, recognized: false, reason: 'not_a_supported_delta' };
}

module.exports = { applyRefinementDelta };
