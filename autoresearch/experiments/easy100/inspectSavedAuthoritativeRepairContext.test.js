'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectSavedAuthoritativeRepairContext } = require('./inspectSavedAuthoritativeRepairContext');

test('writes a de-identified authoritative repair report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authoritative-repair-context-'));
  const inputPath = path.join(root, 'input.jsonl');
  const predictionsPath = path.join(root, 'predictions.jsonl');
  const outputPath = path.join(root, 'report.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '2', messages: [{ role: 'user', content: 'Private request' }] })}\n`);
  fs.writeFileSync(predictionsPath, `${JSON.stringify({ id: '2', predicted: { name: 'Private workflow' } })}\n`);
  const report = inspectSavedAuthoritativeRepairContext({
    inputPath, predictionsPath, outputPath,
    inspect: ({ workflow, userRequest }) => {
      assert.equal(workflow.name, 'Private workflow');
      assert.equal(userRequest, 'Private request');
      return [{ category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: 'test.node', parameterName: 'field' } }];
    },
  });
  assert.equal(report.findingCount, 1);
  assert.equal(JSON.stringify(report).includes('Private'), false);
});
