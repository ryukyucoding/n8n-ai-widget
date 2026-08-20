'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseIndices, runPlanFirstCreateSmoke } = require('./runPlanFirstCreateSmoke');

test('rejects unsafe smoke case input', () => {
  assert.deepEqual(parseIndices('0,1,2'), [0, 1, 2]);
  assert.throws(() => parseIndices('0,-1'), /non-negative/);
});

test('aggregates de-identified planner and builder outcomes', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-first-smoke-'));
  const report = await runPlanFirstCreateSmoke({
    inputPath: 'input', outputDir, caseIndices: [0, 1],
    runPreflight: async ({ caseIndex }) => caseIndex === 0
      ? { caseId: '0', outcome: 'completed', create: { staticStatus: 'plan_incomplete', planCompliance: { missingSelectedNodeTypeCount: 1, nodesOutsideSelectedPlanCount: 0 }, findingCategories: { node_type: 1 } } }
      : { caseId: '1', outcome: 'completed', create: { staticStatus: 'repair', planCompliance: { missingSelectedNodeTypeCount: 0, nodesOutsideSelectedPlanCount: 0 }, findingCategories: { parameter_schema: 2 } } },
  });
  assert.deepEqual(report.aggregate, { attemptedCases: 2, outcomes: { completed: 2 }, staticStatuses: { plan_incomplete: 1, repair: 1 }, findingCategories: { node_type: 1, parameter_schema: 2 }, builderOmittedPlannedNodeCases: 1 });
});
