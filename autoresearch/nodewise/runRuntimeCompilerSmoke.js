'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyCandidateWorkflow } = require('../../chatbot/src/candidateWorkflowVerifier');
const { compileStepSpecification } = require('./runtimeCompiler');

function smokeSpecification() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Read a public object and return selected fields.',
    steps: [
      { id: 'start', capability: 'manual_trigger', purpose: 'Start.', inputs: [], outputs: ['start.signal'], requiredUserSetup: [], configuration: {} },
      { id: 'fetch', capability: 'http_request', purpose: 'Read public object.', inputs: ['start.signal'], outputs: ['fetch.item'], requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/posts/1', cardinality: 'one_object' } } },
      { id: 'select', capability: 'data_transform', purpose: 'Select public fields.', inputs: ['fetch.item'], outputs: ['select.item'], requiredUserSetup: [], configuration: { operation: 'select_fields', input: { kind: 'prior_step', reference: 'fetch.item', cardinality: 'one_object' }, mappings: [{ from: 'id', to: 'id', valueType: 'number' }, { from: 'title', to: 'title', valueType: 'string' }] } },
      { id: 'output', capability: 'set_output', purpose: 'Return the selected fields.', inputs: ['select.item'], outputs: ['output.item'], requiredUserSetup: [], configuration: { input: { kind: 'prior_step', reference: 'select.item', cardinality: 'one_object' }, mappings: [{ from: 'id', to: 'id', valueType: 'number' }, { from: 'title', to: 'title', valueType: 'string' }] } },
    ], expectedOutput: { deliveryShape: 'one_object', fields: ['id', 'title'] }, requiredUserSetup: [],
  };
}

function safeReport(workflow, verification) {
  return {
    schemaVersion: '1.0', kind: 'nodewise_runtime_compiler_smoke', executionPolicy: 'no_n8n_create_or_execution',
    outcome: verification.status === 'pass' || verification.status === 'warning' ? 'static_pass' : 'static_blocked',
    verificationStatus: verification.status,
    nodeCards: workflow.nodes.map((node) => ({ type: node.type, typeVersion: node.typeVersion })),
    findingRuleIds: verification.findings.map((finding) => finding.ruleId),
  };
}

async function run({ outputPath = process.env.RUNTIME_COMPILER_OUTPUT_PATH } = {}) {
  if (!outputPath) throw new Error('RUNTIME_COMPILER_OUTPUT_PATH is required');
  const workflow = compileStepSpecification({ specification: smokeSpecification() });
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest: 'Read public JSONPlaceholder post 1 and return id and title.', candidateWorkflow: workflow });
  const report = safeReport(workflow, verification);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { run, safeReport, smokeSpecification };
