'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { aggregatePilotReport, ensureSafeReport, runCreateModelPilot } = require('./runCreateModelPilot');
const { SAFE_FINDING_CLASSES } = require('./safeStaticFindingSummary');
const { artifactTelemetry, writeSanitizedArtifact } = require('./pilotArtifactTelemetry');
const { createStaticVerifier, runAndPersistCandidateAStaticPilot } = require('./runCandidateAStaticPilot');
const { summarizeCandidateABaseline } = require('./summarizeCandidateABaseline');

const candidate = [{ slot: 'candidate_a', modelTag: 'model-a' }];
const cases = [{ caseId: 'C01', userRequest: 'fixture', acceptanceContract: {}, executionEvidencePolicy: 'safe_execution_assertion' }];
const workflow = { nodes: [], connections: {} };

function fakeFs({ writeError, renameError } = {}) {
  const files = new Map();
  return {
    files,
    mkdirSync() {},
    writeFileSync(target, value) {
      if (writeError) throw Object.assign(new Error('write failed'), { code: 'EROFS' });
      files.set(target, value);
    },
    renameSync(source, target) {
      if (renameError) throw Object.assign(new Error('rename failed'), { code: 'EACCES' });
      files.set(target, files.get(source));
      files.delete(source);
    },
  };
}

test('complete artifact is atomically serialized without raw content', () => {
  const fsOps = fakeFs();
  const result = writeSanitizedArtifact({ artifactPath: '/safe/report.json', report: { schemaVersion: '1.1', records: [{ terminalStatus: 'completed' }] }, fsOps });
  assert.deepEqual(result.telemetry, artifactTelemetry({ artifactWriteStarted: true, artifactWriteFinished: true, atomicRenameStatus: 'success' }));
  assert.equal(result.artifactPath, '/safe/report.json');
  assert.doesNotMatch(fsOps.files.get('/safe/report.json'), /rawOutput|credential|token/i);
});

test('partial HTTP failure preserves completed records and terminal telemetry', async () => {
  let call = 0;
  const report = await runCreateModelPilot({
    candidates: candidate,
    cases,
    repeats: 2,
    generate: async () => {
      call += 1;
      if (call === 2) throw { kind: 'http_failure', telemetry: { requestDispatchStarted: true, responseReceived: true, httpStatus: 503, contentType: 'text/plain' } };
      return { rawOutput: workflow, telemetry: { requestDispatchStarted: true, responseReceived: true, httpStatus: 200, contentType: 'application/json' } };
    },
    verifyStatic: async () => ({ status: 'pass', findings: [], verification: { structural: { status: 'pass' }, dataflow: { status: 'pass' }, semantic: { status: 'skipped' } } }),
  });
  const aggregate = aggregatePilotReport(report);
  assert.equal(aggregate.status, 'partial_availability');
  assert.equal(aggregate.completedRuns, 1);
  assert.equal(aggregate.availabilityFailureCount, 1);
  assert.equal(report.records[1].httpStatus, 503);
  assert.equal(report.records[1].safeContentTypeCategory, 'other_or_unavailable');
  assert.equal(report.records[1].responseReceived, true);
  assert.ok(report.records.every((record) => record.invocationStartedAt && record.invocationFinishedAt && record.terminalStatus));
});

test('timeout and transport retain distinct safe availability categories', async () => {
  let call = 0;
  const report = await runCreateModelPilot({
    candidates: candidate,
    cases,
    repeats: 2,
    stopAfterConsecutiveAvailabilityFailures: Infinity,
    generate: async () => {
      call += 1;
      throw call === 1 ? { kind: 'timeout', telemetry: { requestDispatchStarted: true } } : { kind: 'transport', telemetry: { requestDispatchStarted: true } };
    },
    verifyStatic: async () => ({ status: 'pass', findings: [], verification: {} }),
  });
  assert.deepEqual(report.records.map((record) => [record.timeout, record.availabilityFailureCategory]), [[true, 'timeout'], [false, 'transport']]);
});

test('child exit, signal, and spawn telemetry are retained without stderr', async () => {
  const report = await runCreateModelPilot({
    candidates: candidate,
    cases,
    repeats: 1,
    generate: async () => ({ rawOutput: workflow }),
    verifyStatic: async () => { throw { kind: 'static_verifier_failure', childTelemetry: { childSpawnStatus: 'spawn_failure', childExitCode: 17, childSignal: 'SIGTERM', stderrPresent: true, stderr: 'not retained' } }; },
  });
  const record = report.records[0];
  assert.equal(record.terminalStatus, 'verification_failure');
  assert.deepEqual({ spawn: record.childSpawnStatus, exit: record.childExitCode, signal: record.childSignal, stderr: record.stderrPresent }, { spawn: 'spawn_failure', exit: 17, signal: 'SIGTERM', stderr: true });
  assert.doesNotMatch(JSON.stringify(record), /not retained/);
});

test('serialization, temp-write, and rename failures are safe categories', () => {
  const serialization = writeSanitizedArtifact({ artifactPath: '/safe/x.json', report: { count: 1n }, fsOps: fakeFs() });
  const tempWrite = writeSanitizedArtifact({ artifactPath: '/safe/x.json', report: { count: 1 }, fsOps: fakeFs({ writeError: true }) });
  const rename = writeSanitizedArtifact({ artifactPath: '/safe/x.json', report: { count: 1 }, fsOps: fakeFs({ renameError: true }) });
  assert.equal(serialization.telemetry.writeFailureCategory, 'serialization_failure');
  assert.equal(tempWrite.telemetry.writeFailureCategory, 'temp_write_failure');
  assert.equal(rename.telemetry.writeFailureCategory, 'atomic_rename_failure');
});

test('finally returns a terminal envelope even when setup fails', async () => {
  let persisted = false;
  const terminal = await runAndPersistCandidateAStaticPilot({
    root: '/missing-root',
    emitSummary: () => 'write_failure',
    writeArtifact: ({ report }) => {
      persisted = true;
      assert.equal(report.terminalStatus, 'incomplete');
      return { telemetry: artifactTelemetry({ artifactWriteStarted: true, writeFailureCategory: 'temp_write_failure' }), artifactPath: null };
    },
  });
  assert.equal(persisted, true);
  assert.equal(terminal.terminalStatus, 'incomplete');
  assert.equal(terminal.stdoutWriteStatus, 'write_failure');
});

test('report schema rejects secret-like fields and baseline summary is read-only', () => {
  assert.equal(ensureSafeReport({ nested: { rawOutput: 'forbidden' } }), false);
  const summary = summarizeCandidateABaseline({ artifactPath: path.join(__dirname, 'results', 'candidate-a-static-pilot-baseline-20260731.json') });
  assert.equal(summary.attemptedRuns, 9);
  assert.equal(summary.completedRuns, 5);
  assert.deepEqual(summary.availability, { availableRuns: 5, availabilityFailureRuns: 4, rate: 0.555556 });
  assert.deepEqual(summary.strictJson, { passed: 5, total: 9, rate: 0.555556 });
  assert.deepEqual(summary.repairedJson, { passed: 5, total: 9, rate: 0.555556 });
  assert.deepEqual(Object.keys(summary.safeFindingCategories), SAFE_FINDING_CLASSES);
  assert.doesNotMatch(JSON.stringify(summary), /rawOutput|workflow|token|secret/i);
});

test('benchmark static wrapper observes child exit metadata without retaining stderr', async () => {
  const verifier = async (input, options) => {
    await options.structuralValidator(input);
    return { status: 'pass', findings: [], verification: { structural: { status: 'pass' }, dataflow: { status: 'pass' }, semantic: { status: 'skipped' } } };
  };
  const spawn = () => ({ status: 0, signal: null, stderr: 'private child stderr', stdout: JSON.stringify({ ok: true, findings: [], unstructuredFailure: false }) });
  const verifyStatic = createStaticVerifier({ root: '/benchmark-root', verifier, spawn });
  const result = await verifyStatic({ candidate: workflow, testCase: cases[0] });
  assert.deepEqual(result.childTelemetry, { childSpawnStatus: 'spawned', childExitCode: 0, childSignal: null, stderrPresent: true });
  assert.doesNotMatch(JSON.stringify(result), /private child stderr/);
});
