'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { summarizeRuntimeAwareBatch } = require('./summarizeRuntimeAwareBatch');

test('aggregates only safe runtime finding identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-aware-summary-'));
  const inputPath = path.join(root, 'input.jsonl');
  const predictionsPath = path.join(root, 'predictions.jsonl');
  const outputPath = path.join(root, 'summary.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '0', messages: [{ role: 'user', content: 'Private request' }] })}\n`);
  fs.writeFileSync(predictionsPath, `${JSON.stringify({ id: '0', predicted: { name: 'Private workflow' } })}\n`);
  const report = summarizeRuntimeAwareBatch({
    inputPath, predictionsPath, outputPath,
    canonicalize: ({ workflow }) => workflow,
    inspect: () => [
      { category: 'node_type', repairContext: { requiredNodeType: 'n8n-nodes-base.webhook' } },
      { category: 'parameter_schema', repairContext: { nodeType: 'test.node', parameterName: 'operation' } },
    ],
  });
  assert.equal(report.inspectedCandidates, 1);
  assert.deepEqual(report.totals.missingRequiredNodeTypes, [{ key: 'n8n-nodes-base.webhook', count: 1 }]);
  assert.deepEqual(report.totals.parameterSchemaByNodeAndName, [{ key: 'test.node.operation', count: 1 }]);
  assert.equal(JSON.stringify(report).includes('Private'), false);
});
