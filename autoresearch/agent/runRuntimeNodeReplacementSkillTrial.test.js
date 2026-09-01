'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runRuntimeNodeReplacementSkillTrial } = require('./runRuntimeNodeReplacementSkillTrial');

function response(message) {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const nodeTypes = {
  'n8n-nodes-base.manualTrigger': { versions: { '1': { properties: [] } } },
  'n8n-nodes-base.httpRequest': { versions: { '4.4': { properties: [{ name: 'method' }, { name: 'url' }, { name: 'options' }] } } },
  'n8n-nodes-base.set': { versions: { '3.4': { properties: [] } } },
};

test('selects the capability-matched runtime card through tools and passes validation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-node-replacement-'));
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'v', function: { name: 'get_validation', arguments: '{}' } }] },
    { role: 'assistant', tool_calls: [{ id: 'o', function: { name: 'get_replacement_options', arguments: '{"nodeIndex":1}' } }] },
    { role: 'assistant', tool_calls: [{ id: 'r', function: { name: 'replace_node_with_card', arguments: '{"nodeIndex":1,"type":"n8n-nodes-base.httpRequest","typeVersion":4.4}' } }] },
    { role: 'assistant', tool_calls: [{ id: 'f', function: { name: 'get_validation', arguments: '{}' } }] },
  ];
  let count = 0;
  const report = await runRuntimeNodeReplacementSkillTrial({
    outputPath: path.join(root, 'report.json'), nodeTypes, env: { OLLAMA_BASE_URL: 'http://example.test' },
    fetchImpl: async () => response(messages.shift()),
    verify: async () => ({ status: ++count >= 2 ? 'pass' : 'repair', findings: [] }),
  });
  assert.equal(report.outcome, 'static_pass');
  assert.deepEqual(report.toolCalls, ['get_validation', 'get_replacement_options', 'replace_node_with_card', 'get_validation']);
  assert.deepEqual(report.replacements, [{ requested: 1, applied: 1, capabilityMatched: true }]);
  assert.equal(JSON.stringify(report).includes('httpRequest'), false);
});

test('rejects a replacement that lacks the required capability', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-node-replacement-'));
  const report = await runRuntimeNodeReplacementSkillTrial({
    outputPath: path.join(root, 'report.json'), nodeTypes, maxToolRounds: 2, env: { OLLAMA_BASE_URL: 'http://example.test' },
    fetchImpl: async () => response({ role: 'assistant', tool_calls: [{ id: 'o', function: { name: 'get_replacement_options', arguments: '{"nodeIndex":1}' } }, { id: 'r', function: { name: 'replace_node_with_card', arguments: '{"nodeIndex":1,"type":"n8n-nodes-base.set","typeVersion":3.4}' } }] }),
    verify: async () => ({ status: 'repair', findings: [] }),
  });
  assert.equal(report.replacements.length, 0);
  assert.equal(report.outcome, 'static_blocked');
});
