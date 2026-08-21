'use strict';

const { compileNodewiseSpecification, validateSpecification } = require('./nodewiseCompiler');

const OUTCOMES = new Set(['ready_to_compile', 'clarification_required', 'unsupported_capability']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stringList(value, field, { required = false } = {}) {
  if (value === undefined && !required) return [];
  assert(Array.isArray(value) && value.length > 0, `${field} must be a non-empty array`);
  return value.map((item, index) => {
    assert(typeof item === 'string' && item.trim(), `${field}[${index}] must be a non-empty string`);
    return item.trim();
  });
}

function validatePlannerEnvelope(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'planner result must be an object');
  assert(value.schemaVersion === '1.0', 'schemaVersion must be 1.0');
  assert(value.kind === 'nodewise_planner_result', 'kind must be nodewise_planner_result');
  assert(OUTCOMES.has(value.outcome), 'outcome is unsupported');
  assert(typeof value.goal === 'string' && value.goal.trim(), 'goal is required');

  if (value.outcome === 'ready_to_compile') {
    assert(value.specification && typeof value.specification === 'object', 'ready_to_compile requires specification');
    return { outcome: value.outcome, goal: value.goal.trim(), specification: validateSpecification(value.specification) };
  }

  const requiredUserInputs = stringList(value.requiredUserInputs, 'requiredUserInputs', {
    required: value.outcome === 'clarification_required',
  });
  const capabilityGaps = stringList(value.capabilityGaps, 'capabilityGaps', {
    required: value.outcome === 'unsupported_capability',
  });
  assert(value.specification === undefined, `${value.outcome} must not include a compile specification`);
  return { outcome: value.outcome, goal: value.goal.trim(), requiredUserInputs, capabilityGaps };
}

function compilePlannerEnvelope(value) {
  const result = validatePlannerEnvelope(value);
  if (result.outcome !== 'ready_to_compile') return result;
  return { outcome: result.outcome, workflow: compileNodewiseSpecification(value.specification) };
}

module.exports = { OUTCOMES, compilePlannerEnvelope, validatePlannerEnvelope };
