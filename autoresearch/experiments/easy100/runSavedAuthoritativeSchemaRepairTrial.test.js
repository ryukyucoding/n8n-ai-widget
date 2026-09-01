'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { authoritativeSchemaIssues, runSavedAuthoritativeSchemaRepairTrial } = require('./runSavedAuthoritativeSchemaRepairTrial');

test('projects only actionable authoritative parameter findings', () => {
  const issues = authoritativeSchemaIssues({ workflow: {}, userRequest: 'x', inspect: () => [
    { category: 'node_type', repairContext: { requiredNodeType: 'test.node' } },
    { category: 'parameter_schema', repairContext: { nodeIndex: 2, nodeType: 'test.node', parameterName: 'legacyField' } },
  ] });
  assert.deepEqual(issues, [{ kind: 'parameter_schema', nodeIndex: 2, nodeType: 'test.node', parameterName: 'legacyField' }]);
});

test('keeps candidate data out of the public trial report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authoritative-schema-trial-'));
  const inputPath = path.join(root, 'input.jsonl');
  const predictionsPath = path.join(root, 'predictions.jsonl');
  const outputPath = path.join(root, 'report.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({ id: '0', messages: [{ role: 'user', content: 'Private request' }] })}\n`);
  fs.writeFileSync(predictionsPath, `${JSON.stringify({ id: '0', predicted: { name: 'Private workflow' } })}\n`);
  const findings = [{ category: 'parameter_schema', repairContext: { nodeIndex: 0, nodeType: 'test.node', parameterName: 'legacy' } }];
  const report = await runSavedAuthoritativeSchemaRepairTrial({
    inputPath, predictionsPath, outputPath, caseId: '0', canonicalize: ({ workflow }) => workflow,
    inspect: ({ workflow }) => workflow.repaired ? [] : findings,
    runTrial: async ({ issueProvider }) => {
      issueProvider({});
      const trial = { outcome: 'static_blocked', initialRepairIssues: issueProvider({}), finalRepairIssues: [] };
      Object.defineProperty(trial, 'finalWorkflow', { value: { repaired: true }, enumerable: false });
      return trial;
    },
  });
  assert.equal(report.authoritativeInitialFindingCategories.parameter_schema, 1);
  assert.deepEqual(report.authoritativeFinalFindingCategories, {});
  assert.equal(report.outcome, 'static_pass');
  assert.equal(JSON.stringify(report).includes('Private'), false);
});
