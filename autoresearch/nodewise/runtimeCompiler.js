'use strict';

const { loadRuntimeNodeTypes, latestVersion } = require('../planning/runtimeSchemaCatalog');
const { validateStepSpecification } = require('./stepSpecification');

const TYPE_BY_CAPABILITY = {
  manual_trigger: 'n8n-nodes-base.manualTrigger',
  http_request: 'n8n-nodes-base.httpRequest',
  data_transform: 'n8n-nodes-base.set',
  set_output: 'n8n-nodes-base.set',
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nodeCard(nodeTypes, type) {
  const entry = nodeTypes[type];
  const version = latestVersion(entry?.versions);
  assert(version !== null, `installed runtime does not expose ${type}`);
  return { type, typeVersion: Number(version) };
}

function expression(path) {
  return `={{ $json.${path} }}`;
}

function setParameters(mappings) {
  return {
    assignments: { assignments: mappings.map((mapping) => ({ name: mapping.to, value: expression(mapping.from), type: mapping.valueType })) },
    includeOtherFields: false,
    options: {},
  };
}

function validateCompilable(specification) {
  assert(specification.expectedOutput.deliveryShape === 'one_object', 'first compiler supports one_object output only');
  assert(specification.requiredUserSetup.length === 0, 'user setup must be resolved before compilation');
  const supported = ['manual_trigger', 'http_request', 'data_transform', 'set_output'];
  for (const [index, step] of specification.steps.entries()) {
    assert(supported.includes(step.capability), `first compiler does not support ${step.capability}`);
    assert(step.requiredUserSetup.length === 0, `step ${step.id} requires user setup`);
    if (index === 0) assert(step.capability === 'manual_trigger', 'first compiler requires manual_trigger as the first step');
    if (step.capability === 'http_request') {
      assert(step.configuration.method === 'GET', 'first compiler supports GET only');
      assert(step.configuration.url.kind === 'public_literal', 'first compiler requires a public URL');
      assert(step.configuration.url.cardinality === 'one_object', 'first compiler requires one_object HTTP response');
    }
    if (step.capability === 'data_transform') {
      assert(step.configuration.operation === 'select_fields', 'first compiler supports select_fields only');
      assert(step.configuration.input.cardinality === 'one_object', 'first compiler requires one_object transform input');
    }
    if (step.capability === 'set_output') assert(step.configuration.input.cardinality === 'one_object', 'first compiler requires one_object output input');
  }
}

function compileStepSpecification({ specification, nodeTypes = loadRuntimeNodeTypes() } = {}) {
  const spec = validateStepSpecification({ ...specification, kind: 'nodewise_workflow_intent' });
  validateCompilable(spec);
  const nodes = spec.steps.map((step, index) => {
    const card = nodeCard(nodeTypes, TYPE_BY_CAPABILITY[step.capability]);
    let parameters = {};
    if (step.capability === 'http_request') parameters = { method: 'GET', url: step.configuration.url.reference, options: {} };
    if (step.capability === 'data_transform' || step.capability === 'set_output') parameters = setParameters(step.configuration.mappings);
    return { id: step.id, name: `Step ${index + 1}: ${step.id}`, ...card, parameters, position: [240 + index * 260, 300] };
  });
  const connections = {};
  for (let index = 0; index < nodes.length - 1; index += 1) {
    connections[nodes[index].name] = { main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]] };
  }
  return { name: 'Nodewise compiled workflow', active: false, settings: { executionOrder: 'v1' }, nodes, connections };
}

module.exports = { compileStepSpecification, expression, setParameters, validateCompilable };
