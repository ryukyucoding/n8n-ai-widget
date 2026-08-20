'use strict';

const crypto = require('node:crypto');
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

function stableNodeId(stepId) {
  const hex = crypto.createHash('sha256').update(`nodewise-runtime-compiler:${stepId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function setParameters(mappings) {
  return {
    assignments: { assignments: mappings.map((mapping) => ({ name: mapping.to, value: expression(mapping.from), type: mapping.valueType })) },
    includeOtherFields: false,
    options: {},
  };
}

function countFalseBooleanCode({ field, totalField, falseCountField }) {
  return [
    'const records = $input.all().map((item) => item.json);',
    `const falseCount = records.filter((record) => record.${field} === false).length;`,
    `return [{ json: { ${totalField}: records.length, ${falseCountField}: falseCount } }];`,
  ].join('\n');
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
      assert(['one_object', 'items'].includes(step.configuration.url.cardinality), 'first compiler requires a declared HTTP response cardinality');
    }
    if (step.capability === 'data_transform') {
      assert(['select_fields', 'count_false_boolean'].includes(step.configuration.operation), 'first compiler does not support this transform');
      const expectedCardinality = step.configuration.operation === 'select_fields' ? 'one_object' : 'items';
      assert(step.configuration.input.cardinality === expectedCardinality, `first compiler requires ${expectedCardinality} transform input`);
    }
    if (step.capability === 'set_output') assert(step.configuration.input.cardinality === 'one_object', 'first compiler requires one_object output input');
  }
}

function compileStepSpecification({ specification, nodeTypes = loadRuntimeNodeTypes() } = {}) {
  const spec = validateStepSpecification({ ...specification, kind: 'nodewise_workflow_intent' });
  validateCompilable(spec);
  const nodes = spec.steps.map((step, index) => {
    const type = step.capability === 'data_transform' && step.configuration.operation === 'count_false_boolean'
      ? 'n8n-nodes-base.code'
      : TYPE_BY_CAPABILITY[step.capability];
    const card = nodeCard(nodeTypes, type);
    let parameters = {};
    if (step.capability === 'http_request') parameters = { method: 'GET', url: step.configuration.url.reference, options: {} };
    if (step.capability === 'data_transform' && step.configuration.operation === 'select_fields') parameters = setParameters(step.configuration.mappings);
    if (step.capability === 'data_transform' && step.configuration.operation === 'count_false_boolean') parameters = { jsCode: countFalseBooleanCode(step.configuration) };
    if (step.capability === 'set_output') parameters = setParameters(step.configuration.mappings);
    return { id: stableNodeId(step.id), name: `Step ${index + 1}: ${step.id}`, ...card, parameters, position: [240 + index * 260, 300] };
  });
  const connections = {};
  for (let index = 0; index < nodes.length - 1; index += 1) {
    connections[nodes[index].name] = { main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]] };
  }
  return { name: 'Nodewise compiled workflow', active: false, settings: { executionOrder: 'v1' }, nodes, connections };
}

module.exports = { compileStepSpecification, countFalseBooleanCode, expression, setParameters, stableNodeId, validateCompilable };
