'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runSavedKnownRuntimeMigrationBatch } = require('./runSavedKnownRuntimeMigrationBatch');

test('aggregates only de-identified runtime migration results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-migration-batch-'));
  const inputPath = path.join(root, 'input.jsonl');
  const predictionsPath = path.join(root, 'predictions.jsonl');
  const outputPath = path.join(root, 'report.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '0', messages: [{ role: 'user', content: 'Private request' }] })}\n${JSON.stringify({ id: '1', messages: [{ role: 'user', content: 'Another private request' }] })}\n`);
  fs.writeFileSync(predictionsPath, `${JSON.stringify({ id: '0', predicted: { name: 'Private workflow 0' } })}\n${JSON.stringify({ id: '1', predicted: { name: 'Private workflow 1' } })}\n`);
  let inspectCount = 0;
  const report = await runSavedKnownRuntimeMigrationBatch({
    inputPath, predictionsPath, outputPath,
    canonicalize: ({ workflow }) => workflow,
    inspect: () => (++inspectCount % 2 ? [{ category: 'parameter_schema' }] : []),
    migrate: () => ({ actions: [{ kind: 'known_migration', nodeIndex: 1, nodeType: 'test.node' }] }),
    verify: async () => ({ status: 'pass' }),
  });
  assert.equal(report.checked, 2);
  assert.equal(report.staticPass, 2);
  assert.deepEqual(report.migrationActionKinds, { known_migration: 2 });
  assert.equal(JSON.stringify(report).includes('Private'), false);
});
