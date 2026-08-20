'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseCaseIds, runAuthoritativeSchemaRepairSmoke } = require('./runAuthoritativeSchemaRepairSmoke');

test('rejects unsafe case ID input', () => {
  assert.deepEqual(parseCaseIds('0,1,2'), ['0', '1', '2']);
  assert.throws(() => parseCaseIds('0,../../x'), /numeric/);
});

test('aggregates de-identified trial outcomes', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-repair-smoke-'));
  const report = await runAuthoritativeSchemaRepairSmoke({
    inputPath: 'input', predictionsPath: 'predictions', outputDir, caseIds: ['0', '1'],
    runTrial: async ({ caseId }) => ({
      outcome: caseId === '0' ? 'static_pass' : 'static_blocked', toolCallCount: 4,
      authoritativeInitialFindingCategories: { parameter_schema: 2 },
      authoritativeFinalFindingCategories: caseId === '0' ? {} : { parameter_schema: 1 },
    }),
  });
  assert.deepEqual(report.aggregate, { initialFindingCategories: { parameter_schema: 4 }, finalFindingCategories: { parameter_schema: 1 }, staticPass: 1, toolCallCount: 8 });
});
