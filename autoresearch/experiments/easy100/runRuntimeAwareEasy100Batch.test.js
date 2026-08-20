'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runRuntimeAwareEasy100Batch } = require('./runRuntimeAwareEasy100Batch');

test('writes resumable de-identified results and private parseable candidates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-aware-easy100-'));
  const inputPath = path.join(root, 'input.jsonl');
  const outputDir = path.join(root, 'output');
  fs.writeFileSync(inputPath, [
    { id: '0', messages: [{ role: 'user', content: 'Private one' }] },
    { id: '1', messages: [{ role: 'user', content: 'Private two' }] },
  ].map(JSON.stringify).join('\n'));
  const calls = [];
  const runOne = async ({ caseIndex, onParseableCandidate }) => {
    calls.push(caseIndex);
    const candidate = { name: `private-${caseIndex}`, nodes: [], connections: {} };
    onParseableCandidate({ caseId: String(caseIndex), candidate });
    return {
      caseId: String(caseIndex), outcome: caseIndex === 0 ? 'static_pass' : 'static_blocked', latencyMs: 10,
      attempts: [{ httpStatus: 200, strictJsonStatus: 'pass', repairedJsonStatus: 'pass', staticStatus: caseIndex === 0 ? 'pass' : 'repair', findingCategories: caseIndex === 0 ? {} : { node_type: 1 }, executionReadiness: caseIndex === 0 ? 'eligible_for_controlled_execution' : 'static_blocked' }],
    };
  };
  const first = await runRuntimeAwareEasy100Batch({ inputPath, outputDir, limit: 2, runOne });
  assert.equal(first.status, 'complete');
  assert.equal(first.aggregate.staticPass, 1);
  assert.equal(first.aggregate.staticBlocked, 1);
  assert.equal(JSON.stringify(first).includes('Private'), false);
  assert.equal(calls.length, 2);
  assert.match(fs.readFileSync(path.join(outputDir, 'private', 'runtime-aware-predictions.jsonl'), 'utf8'), /private-0/);
  const second = await runRuntimeAwareEasy100Batch({ inputPath, outputDir, limit: 2, runOne });
  assert.equal(second.aggregate.attemptedCases, 2);
  assert.equal(calls.length, 2);
});
