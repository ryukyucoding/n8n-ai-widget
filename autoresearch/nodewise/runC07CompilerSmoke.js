'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyCandidateWorkflow } = require('../../chatbot/src/candidateWorkflowVerifier');
const { compileStepSpecification } = require('./runtimeCompiler');

function c07Specification() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Return a public user Todo summary.',
    steps: [
      { id: 'start', capability: 'manual_trigger', purpose: 'Start.', inputs: [], outputs: ['start.signal'], requiredUserSetup: [], configuration: {} },
      { id: 'user', capability: 'http_request', purpose: 'Read public user data.', inputs: ['start.signal'], outputs: ['user.item'], requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1', cardinality: 'one_object' } } },
      { id: 'todos', capability: 'http_request', purpose: 'Read public Todo records.', inputs: ['user.item'], outputs: ['todos.items'], requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'summary', capability: 'data_transform', purpose: 'Join user data with incomplete Todo counts.', inputs: ['user.item', 'todos.items'], outputs: ['summary.item'], requiredUserSetup: [], configuration: { operation: 'join_object_and_count_false_boolean', objectInput: { kind: 'prior_step', reference: 'user.item', cardinality: 'one_object' }, itemsInput: { kind: 'prior_step', reference: 'todos.items', cardinality: 'items' }, objectMappings: [{ from: 'name', to: 'name', valueType: 'string' }, { from: 'email', to: 'email', valueType: 'string' }], field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
    ], expectedOutput: { deliveryShape: 'one_object', fields: ['name', 'email', 'totalTodos', 'incompleteTodos'] }, requiredUserSetup: [],
  };
}

function safeReport(workflow, verification) {
  return { schemaVersion: '1.0', kind: 'nodewise_c07_compiler_smoke', executionPolicy: 'no_n8n_create_or_execution', outcome: ['pass', 'warning'].includes(verification.status) ? 'static_pass' : 'static_blocked', verificationStatus: verification.status, nodeCards: workflow.nodes.map((node) => ({ type: node.type, typeVersion: node.typeVersion })), findingRuleIds: verification.findings.map((finding) => finding.ruleId) };
}

async function run({ outputPath = process.env.C07_COMPILER_OUTPUT_PATH } = {}) {
  if (!outputPath) throw new Error('C07_COMPILER_OUTPUT_PATH is required');
  const workflow = compileStepSpecification({ specification: c07Specification() });
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest: 'Fetch JSONPlaceholder user 1 and todos, then return name, email, totalTodos, and incompleteTodos.', candidateWorkflow: workflow });
  const report = safeReport(workflow, verification);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { c07Specification, run, safeReport };
