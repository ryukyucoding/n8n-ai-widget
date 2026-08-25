'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CASES, CANDIDATE, createGenerate, runCandidateAStaticPilot } = require('./runCandidateAStaticPilot');

const WORKFLOW = { nodes: [], connections: {} };

test('candidate_a pilot is fixed to three cases and three repeats with semantic review disabled', async () => {
  let calls = 0;
  const report = await runCandidateAStaticPilot({
    root: path.resolve(__dirname, '..', '..'),
    generate: async ({ candidate, testCase, timeoutMs }) => {
      calls += 1;
      assert.deepEqual(candidate, CANDIDATE);
      assert.ok(CASES.some((item) => item.caseId === testCase.caseId));
      assert.equal(timeoutMs, 120000);
      return { rawOutput: WORKFLOW, candidateCount: 1 };
    },
    verifyStatic: async () => ({ status: 'pass', findings: [], verification: { structural: { status: 'pass' }, dataflow: { status: 'pass' }, semantic: { status: 'skipped' } } }),
  });
  assert.equal(calls, 9);
  assert.equal(report.pilot.incomplete, false);
  assert.equal(report.aggregate.totalRuns, 9);
  assert.equal(report.aggregate.completedRuns, 9);
  assert.equal(report.aggregate.semanticReviewStatus, 'not_run');
  assert.equal(report.pilot.records.every((record) => record.semanticReviewStatus === 'skipped'), true);
  assert.doesNotMatch(JSON.stringify(report), /rawOutput|workflowJson|credential|token|authorization/i);
});

test('candidate_a generator rejects other candidates and sends only the fixed model tag', async () => {
  let received;
  const generate = createGenerate({
    env: { OLLAMA_BASE_URL: 'http://model.example/v1' },
    fetchImpl: async (url, init) => {
      received = { url: String(url), init };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: JSON.stringify(WORKFLOW) } }] }) };
    },
  });
  const result = await generate({ candidate: CANDIDATE, testCase: CASES[0], request: CASES[0].userRequest, acceptanceContract: CASES[0].acceptanceContract, timeoutMs: 120000 });
  assert.equal(received.init.method, 'POST');
  assert.equal(JSON.parse(received.init.body).model, CANDIDATE.modelTag);
  assert.equal(result.httpStatus, 200);
  await assert.rejects(() => generate({ candidate: { slot: 'candidate_b', modelTag: 'other' }, timeoutMs: 1 }), (error) => error.kind === 'route_unconfigured');
});
