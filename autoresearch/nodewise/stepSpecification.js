'use strict';

const { validateIntentPlan } = require('./intentPlan');

const SOURCE_KINDS = new Set(['public_literal', 'user_setup', 'prior_step']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const TRANSFORMS = new Set(['select_fields', 'count_items', 'filter_items']);

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
  return { kind, reference };
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
    const input = sourceReference(config.input, `steps[${index}].configuration.input`, priorStepIds);
    const fields = Array.isArray(config.fields) ? config.fields.map((field, fieldIndex) => nonEmpty(field, `steps[${index}].configuration.fields[${fieldIndex}]`)) : [];
    if (operation === 'select_fields') assert(fields.length >= 1, `steps[${index}].configuration.fields is required for select_fields`);
    return { operation, input, fields };
  }
  if (step.capability === 'set_output') {
    assert(Array.isArray(config.fields) && config.fields.length >= 1, `steps[${index}].configuration.fields is required for set_output`);
    return {
      fields: config.fields.map((field, fieldIndex) => {
        assert(field && typeof field === 'object' && !Array.isArray(field), `steps[${index}].configuration.fields[${fieldIndex}] must be an object`);
        return {
          name: nonEmpty(field.name, `steps[${index}].configuration.fields[${fieldIndex}].name`),
          source: sourceReference(field.source, `steps[${index}].configuration.fields[${fieldIndex}].source`, priorStepIds),
        };
      }),
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
