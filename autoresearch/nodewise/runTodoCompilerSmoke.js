'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyCandidateWorkflow } = require('../../chatbot/src/candidateWorkflowVerifier');
const { compileStepSpecification } = require('./runtimeCompiler');

function todoSpecification() {
  return {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Count incomplete public Todo records.',
    steps: [
      { id: 'start', capability: 'manual_trigger', purpose: 'Start.', inputs: [], outputs: ['start.signal'], requiredUserSetup: [], configuration: {} },
      { id: 'todos', capability: 'http_request', purpose: 'Read public Todo records.', inputs: ['start.signal'], outputs: ['todos.items'], requiredUserSetup: [], configuration: { method: 'GET', url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos?userId=1', cardinality: 'items' } } },
      { id: 'count', capability: 'data_transform', purpose: 'Count incomplete records.', inputs: ['todos.items'], outputs: ['count.summary'], requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: { kind: 'prior_step', reference: 'todos.items', cardinality: 'items' }, field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
    ], expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] }, requiredUserSetup: [],
  };
}

function safeReport(workflow, verification) {
  return { schemaVersion: '1.0', kind: 'nodewise_todo_compiler_smoke', executionPolicy: 'no_n8n_create_or_execution', outcome: ['pass', 'warning'].includes(verification.status) ? 'static_pass' : 'static_blocked', verificationStatus: verification.status, nodeCards: workflow.nodes.map((node) => ({ type: node.type, typeVersion: node.typeVersion })), findingRuleIds: verification.findings.map((finding) => finding.ruleId) };
}

async function run({ outputPath = process.env.TODO_COMPILER_OUTPUT_PATH } = {}) {
  if (!outputPath) throw new Error('TODO_COMPILER_OUTPUT_PATH is required');
  const workflow = compileStepSpecification({ specification: todoSpecification() });
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest: 'Count incomplete JSONPlaceholder todos for user 1.', candidateWorkflow: workflow });
  const report = safeReport(workflow, verification);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { run, safeReport, todoSpecification };
