'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runSavedMechanicalRepairTrial } = require('./runSavedMechanicalRepairTrial');

test('passes a saved candidate only in memory to the bounded repair trial', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-repair-trial-'));
  const inputPath = path.join(root, 'input.jsonl');
  const predictionsPath = path.join(root, 'predictions.jsonl');
  const outputPath = path.join(root, 'report.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '2', messages: [{ role: 'user', content: 'Private request' }] })}\n`);
  fs.writeFileSync(predictionsPath, `${JSON.stringify({ id: '2', predicted: { name: 'Private workflow', nodes: [] } })}\n`);
  let received;
  const report = await runSavedMechanicalRepairTrial({
    inputPath, predictionsPath, outputPath,
    runTrial: async (input) => { received = input; return { outcome: 'static_pass', toolCalls: [], patchActions: [], finalValidation: { status: 'pass', findingCategories: {} } }; },
  });
  assert.equal(received.userRequest, 'Private request');
  assert.equal(received.workflow.name, 'Private workflow');
  assert.equal(JSON.stringify(report).includes('Private'), false);
  assert.equal(report.caseId, '2');
  assert.equal(fs.readFileSync(outputPath, 'utf8').includes('Private'), false);
});
