'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runRuntimeRepairSkillTrial } = require('./runRuntimeRepairSkillTrial');

function response(message) {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('uses only allowlisted repair tools and reaches static pass with a tool loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-repair-skill-'));
  const calls = [
    { role: 'assistant', tool_calls: [{ id: 'v', function: { name: 'get_validation', arguments: '{}' } }] },
    { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'get_runtime_card', arguments: '{"nodeIndex":1}' } }] },
    { role: 'assistant', tool_calls: [{ id: 'p', function: { name: 'apply_runtime_patch', arguments: '{"operations":[{"kind":"set_type_version","nodeIndex":1,"typeVersion":4.4},{"kind":"remove_parameter","nodeIndex":1,"parameterName":"__runtimeRepairProbe__"}]}' } }] },
    { role: 'assistant', tool_calls: [{ id: 'r', function: { name: 'get_validation', arguments: '{}' } }] },
  ];
  let verificationCount = 0;
  const nodeTypes = {
    'n8n-nodes-base.httpRequest': {
      versions: { '4.4': { properties: [{ name: 'method' }, { name: 'url' }, { name: 'options' }] } },
    },
    'n8n-nodes-base.manualTrigger': { versions: { '1': { properties: [] } } },
    'n8n-nodes-base.set': {
      versions: { '3.4': { properties: [{ name: 'assignments' }, { name: 'includeOtherFields' }, { name: 'options' }] } },
    },
  };
  const report = await runRuntimeRepairSkillTrial({
    outputPath: path.join(root, 'report.json'),
    env: { OLLAMA_BASE_URL: 'http://example.test' },
    nodeTypes,
    fetchImpl: async () => response(calls.shift()),
    verify: async () => ({ status: ++verificationCount >= 2 ? 'pass' : 'repair', findings: [] }),
  });
  assert.equal(report.outcome, 'static_pass');
  assert.equal(report.initialValidation.status, 'repair');
  assert.equal(report.initialRepairIssues.some((issue) => issue.kind === 'type_version'), true);
  assert.equal(report.finalRepairIssues.some((issue) => issue.parameterName === '__runtimeRepairProbe__'), false);
  assert.deepEqual(report.toolCalls, ['get_validation', 'get_runtime_card', 'apply_runtime_patch', 'get_validation']);
  assert.equal(report.patchActions[0].applied, 2);
});

test('refuses a patch before the target runtime card has been inspected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-repair-skill-'));
  const report = await runRuntimeRepairSkillTrial({
    outputPath: path.join(root, 'report.json'), maxToolRounds: 1,
    env: { OLLAMA_BASE_URL: 'http://example.test' },
    fetchImpl: async () => response({ role: 'assistant', tool_calls: [{ id: 'p', function: { name: 'apply_runtime_patch', arguments: '{"operations":[{"kind":"set_type_version","nodeIndex":1,"typeVersion":4.4}]}' } }] }),
    verify: async () => ({ status: 'repair', findings: [] }),
  });
  assert.equal(report.patchActions[0].applied, 0);
  assert.equal(report.outcome, 'static_blocked');
});
