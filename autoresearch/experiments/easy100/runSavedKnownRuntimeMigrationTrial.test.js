'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runSavedKnownRuntimeMigrationTrial } = require('./runSavedKnownRuntimeMigrationTrial');

test('keeps saved data private while reporting only migration outcomes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'known-runtime-migration-'));
  const inputPath = path.join(root, 'input.jsonl');
  const predictionsPath = path.join(root, 'predictions.jsonl');
  const outputPath = path.join(root, 'report.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '2', messages: [{ role: 'user', content: 'Private request' }] })}\n`);
  fs.writeFileSync(predictionsPath, `${JSON.stringify({ id: '2', predicted: { name: 'Private workflow' } })}\n`);
  let inspected = 0;
  const report = await runSavedKnownRuntimeMigrationTrial({
    inputPath, predictionsPath, outputPath,
    canonicalize: ({ workflow }) => workflow,
    inspect: () => (++inspected === 1 ? [{
      category: 'parameter_schema',
      message: 'Private request must not be reported',
      repairContext: { nodeIndex: 0, nodeType: 'test.node', parameterName: 'field' },
    }] : []),
    migrate: () => ({ actions: [{ kind: 'known_migration', nodeIndex: 1, nodeType: 'test.node' }], blocked: [] }),
    verifyTrial: async () => ({ outcome: 'static_pass', toolCalls: [], patchActions: [], finalValidation: { status: 'pass', findingCategories: {} } }),
  });
  assert.equal(report.outcome, 'static_pass');
  assert.equal(report.authoritativeInitialFindingCount, 1);
  assert.equal(report.authoritativeFinalFindingCount, 0);
  assert.deepEqual(report.authoritativeInitialFindings, [{
    category: 'parameter_schema',
    repairContext: { nodeIndex: 0, nodeType: 'test.node', parameterName: 'field' },
  }]);
  assert.equal(JSON.stringify(report).includes('Private'), false);
});
