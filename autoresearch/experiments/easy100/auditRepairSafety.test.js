'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { auditRepairSafety } = require('./auditRepairSafety');

test('emits only aggregate repair dispositions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-safety-'));
  const inputPath = path.join(root, 'input.jsonl');
  const predictionsPath = path.join(root, 'predictions.jsonl');
  const outputPath = path.join(root, 'report.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '0', messages: [{ role: 'user', content: 'Private request' }] })}\n`);
  fs.writeFileSync(predictionsPath, `${JSON.stringify({ id: '0', predicted: { name: 'Private workflow' } })}\n`);
  const report = auditRepairSafety({ inputPath, predictionsPath, outputPath, canonicalize: ({ workflow }) => workflow, inspect: () => [], classify: () => ({ classifications: [{ disposition: 'requires_user_setup' }], migrationActions: ['known'] }) });
  assert.deepEqual(report.dispositions, [{ key: 'requires_user_setup', count: 1 }]);
  assert.equal(JSON.stringify(report).includes('Private'), false);
});
