'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { planInstruction, runPlanFirstCreatePreflight, safePlanCompliance } = require('./runPlanFirstCreatePreflight');

function writeFixture(root) {
  const inputPath = path.join(root, 'easy.jsonl');
  const schemaPath = path.join(root, 'schema.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '0', messages: [{ role: 'system', content: 'Return workflow JSON.' }, { role: 'user', content: 'Read one URL.' }] })}\n`);
  fs.writeFileSync(schemaPath, JSON.stringify({
    nodeTypes: {
      'n8n-nodes-base.httpRequest': {
        versions: {
          '4.2': { displayName: 'HTTP Request', description: 'Read a URL', properties: [], inputs: ['main'], outputs: ['main'] },
        },
      },
    },
  }));
  return { inputPath, schemaPath };
}

function plan() {
  return { goal: 'Read one URL', generator_instruction: 'Use HTTP.', selected_nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2 }], required_user_inputs: [], required_configuration: [], output_contract: { required: false } };
}

test('plan-first preflight reports only safe completion metrics', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-first-'));
  const { inputPath, schemaPath } = writeFixture(root);
  const responses = [
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan()) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ name: 'x', nodes: [], connections: {} }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  const report = await runPlanFirstCreatePreflight({ inputPath, outputPath: path.join(root, 'report.json'), schemaPath, env: { OLLAMA_BASE_URL: 'http://example.test' }, fetchImpl: async () => responses.shift(), verify: async () => ({ status: 'pass', findings: [] }) });
  assert.equal(report.outcome, 'completed');
  assert.equal(report.planner.allSelectedNodesInRuntimeCatalog, true);
  assert.equal(report.create.staticStatus, 'plan_incomplete');
  assert.deepEqual(report.create.planCompliance, { generatedNodeCount: 0, nodesOutsideSelectedPlanCount: 0, missingSelectedNodeTypeCount: 1 });
  assert.equal(report.create.staticStatus, 'plan_incomplete');
  assert.equal(JSON.stringify(report).includes('Read one URL'), false);
});

test('generator instruction carries only selected runtime cards and compliance is deidentified', () => {
  const selectedPlan = plan();
  const instruction = planInstruction(selectedPlan, { candidateNodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: [] }, { type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: [] }] });
  assert.equal(instruction.includes('n8n-nodes-base.httpRequest'), true);
  assert.equal(instruction.includes('n8n-nodes-base.set'), false);
  assert.deepEqual(safePlanCompliance({ nodes: [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2 }, { type: 'invented', typeVersion: 1 }] }, selectedPlan), { generatedNodeCount: 2, nodesOutsideSelectedPlanCount: 1, missingSelectedNodeTypeCount: 0 });
});

test('plan-first preflight does not call Create after planner rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-first-'));
  const { inputPath, schemaPath } = writeFixture(root);
  let calls = 0;
  const report = await runPlanFirstCreatePreflight({ inputPath, outputPath: path.join(root, 'report.json'), schemaPath, env: { OLLAMA_BASE_URL: 'http://example.test' }, fetchImpl: async () => { calls += 1; return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }); } });
  assert.equal(report.outcome, 'planner_or_create_unavailable_or_rejected');
  assert.equal(calls, 1);
});

test('plan-first preflight classifies an incomplete planner envelope without calling Create', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-first-'));
  const { inputPath, schemaPath } = writeFixture(root);
  let calls = 0;
  const report = await runPlanFirstCreatePreflight({ inputPath, outputPath: path.join(root, 'report.json'), schemaPath, env: { OLLAMA_BASE_URL: 'http://example.test' }, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ selected_nodes: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(report.failureCategory, 'plan_contract_rejected');
  assert.equal(report.safeFailureCategory, 'goal_missing');
  assert.equal(calls, 1);
});
