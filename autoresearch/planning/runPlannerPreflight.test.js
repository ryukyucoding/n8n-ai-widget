'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runPlannerPreflight } = require('./runPlannerPreflight');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-preflight-'));
  const inputPath = path.join(root, 'input.jsonl');
  const schemaPath = path.join(root, 'schema.json');
  fs.writeFileSync(inputPath, JSON.stringify({ id: 0, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Read an API' }] }) + '\n');
  fs.writeFileSync(schemaPath, JSON.stringify({ nodeTypes: { 'n8n-nodes-base.httpRequest': { versions: { '4.4': { displayName: 'HTTP Request', description: 'Read an API', properties: [], inputs: ['main'], outputs: ['main'] } } } } }));
  return { root, inputPath, schemaPath };
}

test('records only a safe summary of a runtime-catalog-compliant plan', async () => {
  const { root, inputPath, schemaPath } = fixture();
  const plan = { goal: 'Read an API', trigger: 'manual', selected_nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }], output_contract: { required: true, delivery_shape: 'single_object_item', item_count: 1, fields: [{ path: 'result', required: true, expected_type: 'object' }] }, data_sources: [], data_flow_requirements: [], assumptions: [], required_user_inputs: [], required_configuration: [], generator_instruction: 'Use HTTP Request.' };
  const report = await runPlannerPreflight({ inputPath, outputPath: path.join(root, 'report.json'), schemaPath, env: { OLLAMA_BASE_URL: 'http://example.test' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(report.outcome, 'plan_ready');
  assert.equal(report.plan.allSelectedNodesInRuntimeCatalog, true);
  assert.equal(Object.hasOwn(report, 'rawPlan'), false);
});

test('classifies a planner HTTP error without storing its response body', async () => {
  const { root, inputPath, schemaPath } = fixture();
  const report = await runPlannerPreflight({ inputPath, outputPath: path.join(root, 'report.json'), schemaPath, env: { OLLAMA_BASE_URL: 'http://example.test' }, fetchImpl: async () => new Response('{"error":"bad parameter"}', { status: 500, headers: { 'content-type': 'application/json' } }) });
  assert.equal(report.failureCategory, 'http_failure');
  assert.equal(report.safeFailureCategory, 'request_parameter_rejected');
  assert.equal(Object.hasOwn(report, 'rawPlan'), false);
});

test('can inspect a runtime planning context without a model call', async () => {
  const { root, inputPath, schemaPath } = fixture();
  const report = await runPlannerPreflight({ inputPath, outputPath: path.join(root, 'report.json'), schemaPath, dryRun: true, fetchImpl: async () => { throw new Error('must not call model'); } });
  assert.equal(report.outcome, 'planning_context_ready');
  assert.ok(report.runtimeContextStats.candidateNodeCount > 0);
  assert.equal(Object.hasOwn(report, 'rawPlan'), false);
});
