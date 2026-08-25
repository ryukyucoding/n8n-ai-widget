'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonCandidate } = require('./createJsonPolicy');
const { runReadinessChecks } = require('./runCreateModelPilot');

const WORKFLOW = '{"nodes":[],"connections":{}}';

test('strict valid workflow JSON is strict pass and repaired pass', () => {
  const parsed = parseJsonCandidate(WORKFLOW);
  assert.deepEqual({ strict: parsed.strictJsonStatus, repaired: parsed.repairedJsonStatus, category: parsed.outputCategory }, {
    strict: 'pass', repaired: 'pass', category: 'strict_json',
  });
});

test('markdown fence is strict fail and repaired pass', () => {
  const parsed = parseJsonCandidate(`\`\`\`json\n${WORKFLOW}\n\`\`\``);
  assert.deepEqual({ strict: parsed.strictJsonStatus, repaired: parsed.repairedJsonStatus, category: parsed.outputCategory }, {
    strict: 'fail', repaired: 'pass', category: 'markdown_fenced_json',
  });
});

test('prose plus JSON uses the same balanced-object repair policy as Create', () => {
  const parsed = parseJsonCandidate(`Here is the workflow: ${WORKFLOW}`);
  assert.deepEqual({ strict: parsed.strictJsonStatus, repaired: parsed.repairedJsonStatus, category: parsed.outputCategory }, {
    strict: 'fail', repaired: 'pass', category: 'prose_plus_json',
  });
});

test('non-workflow JSON is never repaired-ready', () => {
  const parsed = parseJsonCandidate('{"status":"ok"}');
  assert.deepEqual({ strict: parsed.strictJsonStatus, repaired: parsed.repairedJsonStatus, category: parsed.outputCategory }, {
    strict: 'pass', repaired: 'fail', category: 'non_workflow_json',
  });
});

test('transport or model errors are availability failures without raw error retention', async () => {
  const report = await runReadinessChecks({
    candidates: [{ slot: 'candidate_x', modelTag: 'model-x' }],
    generate: async () => { throw { kind: 'model_not_found', httpStatus: 404, contentType: 'text/plain', body: 'not retained' }; },
  });
  const entry = report.reports[0];
  assert.deepEqual({ outcome: entry.outcome, httpStatus: entry.httpStatus, contentType: entry.contentType, category: entry.outputCategory }, {
    outcome: 'availability_failure', httpStatus: 404, contentType: 'other_or_unavailable', category: 'model_not_found',
  });
  assert.doesNotMatch(JSON.stringify(report), /not retained/);
});
