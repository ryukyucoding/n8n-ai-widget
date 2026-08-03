'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregatePilotReport, createReadinessRequest, ensureSafeReport, runCreateModelPilot, runReadinessChecks } = require('./runCreateModelPilot');

const candidates = [
  { slot: 'candidate_a', modelTag: 'qwen2.5-coder-32b-ft-original:latest' },
  { slot: 'candidate_b', modelTag: 'qwen_n8n_v3:latest' },
  { slot: 'candidate_c', modelTag: 'gemma4:31b' },
];
const cases = [
  { caseId: 'C01', userRequest: 'safe fixture', acceptanceContract: {}, executionEvidencePolicy: 'safe_execution_assertion' },
  { caseId: 'C04', userRequest: 'safe fixture', acceptanceContract: {}, executionEvidencePolicy: 'skipped_or_manual_or_sandbox_evidence' },
  { caseId: 'C07', userRequest: 'safe fixture', acceptanceContract: {}, executionEvidencePolicy: 'skipped_or_manual_or_sandbox_evidence' },
];

test('readiness request is minimal and does not ask for n8n execution', () => {
  assert.match(createReadinessRequest(), /Manual Trigger only/i);
  assert.doesNotMatch(createReadinessRequest(), /POST|execute workflow/i);
});

test('readiness reports JSON parsing and continues after one unavailable model', async () => {
  const report = await runReadinessChecks({
    candidates,
    now: () => 0,
    generate: async ({ candidate }) => {
      if (candidate.slot === 'candidate_b') throw { stage: 'timeout', httpStatus: 504 };
      return { httpStatus: 200, contentType: 'application/json', rawOutput: '{"nodes":[],"connections":{}}' };
    },
  });
  assert.deepEqual(report.reports.map((entry) => entry.outcome), ['completed', 'timeout', 'completed']);
  assert.deepEqual(report.reports.map((entry) => entry.outputCategory), ['strict_json', 'timeout', 'strict_json']);
  assert.equal(report.reports[0].strictJsonStatus, 'pass');
  assert.equal(report.reports[0].repairedJsonStatus, 'pass');
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('pilot records all model-case-repeat attempts and never calls execution', async () => {
  let generationCalls = 0;
  const report = await runCreateModelPilot({
    candidates,
    cases,
    repeats: 3,
    generate: async () => { generationCalls += 1; return { rawOutput: '{"nodes":[],"connections":{}}', candidateCount: 1 }; },
    verifyStatic: async ({ testCase }) => ({
      status: 'pass',
      findings: [],
      verification: { structural: { status: 'pass' }, dataflow: { status: 'pass' }, semantic: { status: testCase.caseId === 'C01' ? 'pass' : 'skipped' } },
    }),
  });
  assert.equal(generationCalls, 27);
  assert.equal(report.records.length, 27);
  assert.ok(report.records.filter((entry) => entry.caseId !== 'C01').every((entry) => entry.executionEvidenceStatus === 'skipped'));
  assert.ok(report.records.every((entry) => entry.firstCandidatePass));
});

test('a bad output or a single generation failure does not interrupt later attempts', async () => {
  let call = 0;
  const report = await runCreateModelPilot({
    candidates: candidates.slice(0, 1),
    cases: cases.slice(0, 2),
    repeats: 2,
    generate: async () => {
      call += 1;
      if (call === 1) return { rawOutput: 'not json' };
      if (call === 2) throw { stage: 'transport' };
      return { rawOutput: '{"nodes":[],"connections":{}}' };
    },
    verifyStatic: async () => ({ status: 'repair', findings: [{ ruleId: 'connection.shape.invalid', category: 'connection_shape', severity: 'repair' }], verification: { structural: { status: 'repair' }, dataflow: { status: 'not_run' }, semantic: { status: 'skipped' } } }),
  });
  assert.equal(report.records.length, 4);
  assert.deepEqual(report.records.slice(0, 2).map((entry) => entry.outcome), ['invalid_output', 'availability_failure']);
  assert.equal(report.records[2].findingCounts.connection_shape, 1);
});

test('report contains no raw prompt, workflow, identifiers, or sensitive fields', async () => {
  const report = await runCreateModelPilot({
    candidates: candidates.slice(0, 1),
    cases: cases.slice(0, 1),
    repeats: 1,
    generate: async () => ({ rawOutput: '{"nodes":[],"connections":{}}' }),
    verifyStatic: async () => ({ status: 'repair', findings: [{ category: 'semantic', message: 'email person@example.test token hidden' }], verification: { structural: { status: 'repair' }, dataflow: { status: 'pass' }, semantic: { status: 'repair' } } }),
  });
  const text = JSON.stringify(report);
  assert.equal(ensureSafeReport(report), true);
  assert.doesNotMatch(text, /safe fixture|person@example\.test|token hidden|rawOutput|workflowId/);
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('repaired JSON is statically verified before it can pass', async () => {
  let verifierCalls = 0;
  const report = await runCreateModelPilot({
    candidates: candidates.slice(0, 1),
    cases: cases.slice(0, 1),
    repeats: 1,
    generate: async () => ({ rawOutput: 'Workflow follows: ' + JSON.stringify({ nodes: [], connections: {} }) }),
    verifyStatic: async () => {
      verifierCalls += 1;
      return { status: 'repair', findings: [{ category: 'connection', message: 'not retained' }], verification: { structural: { status: 'repair' }, dataflow: { status: 'not_run' }, semantic: { status: 'skipped' } } };
    },
  });
  const record = report.records[0];
  assert.equal(verifierCalls, 1);
  assert.equal(record.outputCategory, 'prose_plus_json');
  assert.equal(record.strictJsonStatus, 'fail');
  assert.equal(record.repairedJsonStatus, 'pass');
  assert.equal(record.firstCandidatePass, false);
});

test('pilot stops after two consecutive availability failures and aggregates safe metrics', async () => {
  let calls = 0;
  const report = await runCreateModelPilot({
    candidates: candidates.slice(0, 1),
    cases,
    repeats: 3,
    stopAfterConsecutiveAvailabilityFailures: 2,
    generate: async () => {
      calls += 1;
      throw { kind: 'transport' };
    },
    verifyStatic: async () => {
      throw new Error('static verifier must not run after availability failure');
    },
  });
  const aggregate = aggregatePilotReport(report);
  assert.equal(calls, 2);
  assert.equal(report.incomplete, true);
  assert.equal(report.plannedRuns, 9);
  assert.equal(aggregate.totalRuns, 9);
  assert.equal(aggregate.attemptedRuns, 2);
  assert.equal(aggregate.completedRuns, 0);
  assert.equal(aggregate.incompleteRuns, 7);
  assert.equal(aggregate.availabilityFailureCount, 2);
  assert.equal(aggregate.semanticReviewStatus, 'not_run');
  assert.equal(ensureSafeReport(aggregate), true);
  assert.doesNotThrow(() => JSON.stringify(aggregate));
});

test('pilot retains only fixed static finding classes, severities, normalization, and blocking state', async () => {
  const report = await runCreateModelPilot({
    candidates: candidates.slice(0, 1),
    cases: cases.slice(0, 1),
    repeats: 1,
    generate: async () => ({ rawOutput: '{"nodes":[],"connections":{}}' }),
    verifyStatic: async () => ({
      status: 'repair',
      findings: [
        { ruleId: 'connection.port.target_input.normalized', severity: 'warning', normalized: true, location: { sourceNodeName: 'Hidden' } },
        { ruleId: 'parameter.schema.invalid', severity: 'repair', message: 'private field value' },
      ],
      verification: { structural: { status: 'repair' }, dataflow: { status: 'not_run' }, semantic: { status: 'skipped' } },
    }),
  });
  const summary = report.records[0].staticFindingSummary;
  assert.equal(summary.connection_port.deterministicNormalization, 'fully_resolved');
  assert.equal(summary.connection_port.blocking, false);
  assert.equal(summary.parameter_schema.blocking, true);
  assert.doesNotMatch(JSON.stringify(summary), /Hidden|private field value|sourceNodeName/i);
});
