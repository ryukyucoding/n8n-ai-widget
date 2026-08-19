'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildRepairInstructions, repairMessages, runRuntimeAwareWorkflowAgent } = require('./runRuntimeAwareWorkflowAgent');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-'));
  const inputPath = path.join(root, 'input.jsonl');
  const schemaPath = path.join(root, 'schema.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '0', messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'Use HTTP Request.' }] })}\n`);
  fs.writeFileSync(schemaPath, JSON.stringify({ nodeTypes: { 'n8n-nodes-base.httpRequest': { versions: { '4.2': { displayName: 'HTTP Request', description: 'Read an API', properties: [], inputs: ['main'], outputs: ['main'] } } } } }));
  return { root, inputPath, schemaPath };
}

test('repairs one static failure without retaining workflow data in the report', async () => {
  const { root, inputPath, schemaPath } = fixture();
  const bad = { name: 'private name', nodes: [], connections: {} };
  const good = { name: 'private name', nodes: [], connections: {} };
  const responses = [bad, good].map((workflow) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(workflow) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  let verifies = 0;
  const report = await runRuntimeAwareWorkflowAgent({ inputPath, outputPath: path.join(root, 'report.json'), schemaPath, env: { OLLAMA_BASE_URL: 'http://example.test' }, fetchImpl: async () => responses.shift(), verify: async () => {
    verifies += 1;
    if (verifies === 1) {
      const error = new Error('static');
      error.findings = [{ ruleId: 'benchmark.node_type', category: 'node_schema', severity: 'repair' }];
      throw error;
    }
    return { status: 'pass', findings: [] };
  } });
  assert.equal(report.outcome, 'static_pass');
  assert.equal(report.attempts.length, 2);
  assert.equal(JSON.stringify(report).includes('private name'), false);
});

test('does not expose credentials when supplying a candidate for repair', () => {
  const messages = repairMessages({ description: 'x', repairContext: { candidateNodes: [] }, candidate: { nodes: [{ credentials: { token: 'secret' } }] }, repairInstructions: {} });
  assert.equal(messages.at(-1).content.includes('secret'), false);
});

test('makes unsupported candidate node identities actionable without including parameter values', () => {
  const instructions = buildRepairInstructions({
    candidate: { nodes: [{ type: 'old.node', typeVersion: 1, parameters: { token: 'secret' } }] },
    repairContext: { candidateNodes: [{ type: 'current.node', typeVersion: 2, parameters: [{ name: 'operation' }] }] },
    findingCategories: { node_type: 1 },
  });
  assert.deepEqual(instructions.incompatibleNodes, [{ nodeIndex: 0, candidateType: 'old.node', candidateTypeVersion: 1, requiredAction: 'replace_with_an_allowed_runtime_card' }]);
  assert.equal(JSON.stringify(instructions).includes('secret'), false);
});

test('forwards an explicitly selected reasoning effort and reports only a safe output category', async () => {
  const { root, inputPath, schemaPath } = fixture();
  let requestBody;
  const response = new Response(JSON.stringify({ choices: [{ message: { content: 'not a workflow' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const report = await runRuntimeAwareWorkflowAgent({
    inputPath, outputPath: path.join(root, 'report.json'), schemaPath, maxAttempts: 1, reasoningEffort: 'none',
    env: { OLLAMA_BASE_URL: 'http://example.test' },
    fetchImpl: async (_url, options) => { requestBody = JSON.parse(options.body); return response; },
  });
  assert.equal(requestBody.reasoning_effort, 'none');
  assert.equal(report.reasoningEffort, 'none');
  assert.equal(typeof report.attempts[0].outputCategory, 'string');
  assert.equal(JSON.stringify(report).includes('not a workflow'), false);
});
