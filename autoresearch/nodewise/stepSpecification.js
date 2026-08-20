'use strict';

const { validateIntentPlan } = require('./intentPlan');

const SOURCE_KINDS = new Set(['public_literal', 'user_setup', 'prior_step']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const TRANSFORMS = new Set(['select_fields', 'count_items', 'filter_items', 'count_false_boolean', 'join_object_and_count_false_boolean']);
const CARDINALITIES = new Set(['one_object', 'items']);
const VALUE_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, field) {
  assert(typeof value === 'string' && value.trim(), `${field} must be a non-empty string`);
  return value.trim();
}

function sourceReference(value, field, priorStepIds) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${field} must be an object`);
  const kind = nonEmpty(value.kind, `${field}.kind`);
  assert(SOURCE_KINDS.has(kind), `${field}.kind is not supported`);
  const reference = nonEmpty(value.reference, `${field}.reference`);
  if (kind === 'public_literal') assert(/^https:\/\//.test(reference), `${field}.reference must be a public HTTPS URL`);
  if (kind === 'prior_step') assert(priorStepIds.has(reference.split('.', 1)[0]), `${field}.reference must reference an earlier step`);
  const cardinality = nonEmpty(value.cardinality, `${field}.cardinality`);
  assert(CARDINALITIES.has(cardinality), `${field}.cardinality is not supported`);
  return { kind, reference, cardinality };
}

function mappings(value, field) {
  assert(Array.isArray(value) && value.length >= 1 && value.length <= 20, `${field} must contain 1 to 20 mappings`);
  return value.map((mapping, index) => {
    assert(mapping && typeof mapping === 'object' && !Array.isArray(mapping), `${field}[${index}] must be an object`);
    const from = nonEmpty(mapping.from, `${field}[${index}].from`);
    const to = nonEmpty(mapping.to, `${field}[${index}].to`);
    const valueType = nonEmpty(mapping.valueType, `${field}[${index}].valueType`);
    assert(VALUE_TYPES.has(valueType), `${field}[${index}].valueType is not supported`);
    return { from, to, valueType };
  });
}

function validateConfiguration(step, index, priorStepIds) {
  const config = step.configuration || {};
  assert(config && typeof config === 'object' && !Array.isArray(config), `steps[${index}].configuration must be an object`);
  if (step.capability === 'manual_trigger' || step.capability === 'schedule_trigger') {
    assert(Object.keys(config).length === 0, `steps[${index}].configuration must be empty for a trigger`);
    return {};
  }
  if (step.capability === 'http_request') {
    const method = nonEmpty(config.method, `steps[${index}].configuration.method`).toUpperCase();
    assert(HTTP_METHODS.has(method), `steps[${index}].configuration.method is not supported`);
    return { method, url: sourceReference(config.url, `steps[${index}].configuration.url`, priorStepIds) };
  }
  if (step.capability === 'data_transform') {
    const operation = nonEmpty(config.operation, `steps[${index}].configuration.operation`);
    assert(TRANSFORMS.has(operation), `steps[${index}].configuration.operation is not supported`);
    if (operation === 'join_object_and_count_false_boolean') {
      const objectInput = sourceReference(config.objectInput, `steps[${index}].configuration.objectInput`, priorStepIds);
      const itemsInput = sourceReference(config.itemsInput, `steps[${index}].configuration.itemsInput`, priorStepIds);
      const field = nonEmpty(config.field, `steps[${index}].configuration.field`);
      const totalField = nonEmpty(config.totalField, `steps[${index}].configuration.totalField`);
      const falseCountField = nonEmpty(config.falseCountField, `steps[${index}].configuration.falseCountField`);
      assert(objectInput.cardinality === 'one_object', `steps[${index}].configuration.objectInput must have one_object cardinality`);
      assert(itemsInput.cardinality === 'items', `steps[${index}].configuration.itemsInput must have items cardinality`);
      return { operation, objectInput, itemsInput, objectMappings: mappings(config.objectMappings, `steps[${index}].configuration.objectMappings`), field, totalField, falseCountField };
    }
    const input = sourceReference(config.input, `steps[${index}].configuration.input`, priorStepIds);
    if (operation === 'select_fields') return { operation, input, mappings: mappings(config.mappings, `steps[${index}].configuration.mappings`) };
    if (operation === 'count_false_boolean') {
      const field = nonEmpty(config.field, `steps[${index}].configuration.field`);
      const totalField = nonEmpty(config.totalField, `steps[${index}].configuration.totalField`);
      const falseCountField = nonEmpty(config.falseCountField, `steps[${index}].configuration.falseCountField`);
      assert(input.cardinality === 'items', `steps[${index}].configuration.input must have items cardinality`);
      return { operation, input, field, totalField, falseCountField };
    }
    return { operation, input, mappings: [] };
  }
  if (step.capability === 'set_output') {
    const input = sourceReference(config.input, `steps[${index}].configuration.input`, priorStepIds);
    return {
      input,
      mappings: mappings(config.mappings, `steps[${index}].configuration.mappings`),
    };
  }
  throw new Error(`steps[${index}].capability cannot yet be compiled safely`);
}

// The specification retains the semantic plan and adds only values a
// deterministic compiler needs. It deliberately excludes credentials and raw
// n8n parameter names.
function validateStepSpecification(specification) {
  const intent = validateIntentPlan(specification);
  const priorStepIds = new Set();
  const steps = intent.steps.map((step, index) => {
    const rawStep = specification.steps[index];
    const configuration = validateConfiguration({ ...step, configuration: rawStep.configuration }, index, priorStepIds);
    priorStepIds.add(step.id);
    return { ...step, configuration };
  });
  return { ...intent, kind: 'nodewise_step_specification', steps };
}

function parseAndValidateStepSpecification(text) {
  let specification;
  try { specification = JSON.parse(text); } catch { throw new Error('step specification must be one JSON object'); }
  assert(specification?.kind === 'nodewise_step_specification', 'kind must be nodewise_step_specification');
  return validateStepSpecification({ ...specification, kind: 'nodewise_workflow_intent' });
}

module.exports = { parseAndValidateStepSpecification, validateStepSpecification };
