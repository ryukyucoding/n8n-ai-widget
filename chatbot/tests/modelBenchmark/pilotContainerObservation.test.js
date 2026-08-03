'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectTerminalArtifact, observeAndCopyPilotArtifact } = require('./pilotContainerObservation');

const terminalArtifact = JSON.stringify({
  terminalStatus: 'complete',
  pilot: { terminalStatus: 'complete' },
  aggregate: { status: 'complete' },
  artifactWriteFinished: true,
  atomicRenameStatus: 'success',
});

function dockerExec(overrides = {}) {
  return { exitCode: 0, signal: null, stderrPresent: false, stdoutPresent: true, timedOut: false, ...overrides };
}

test('copies an immediately visible terminal artifact after docker exec', async () => {
  let copied = 0;
  const result = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec(),
    readContainerArtifact: async () => terminalArtifact,
    copyArtifact: async () => { copied += 1; },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.copyStatus, 'copied');
  assert.equal(result.artifactObservation.pollCount, 0);
  assert.equal(copied, 1);
});

test('polls a bounded number of times for a delayed terminal artifact', async () => {
  const samples = [null, null, terminalArtifact];
  let waits = 0;
  const result = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec(),
    readContainerArtifact: async () => samples.shift(),
    copyArtifact: async () => {},
    maxPolls: 3,
    wait: async () => { waits += 1; },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.artifactObservation.pollCount, 2);
  assert.equal(waits, 2);
});

test('missing artifact, invalid JSON, and missing terminal envelope have distinct categories', async () => {
  const missing = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec(), readContainerArtifact: async () => null, copyArtifact: async () => {}, maxPolls: 1, wait: async () => {},
  });
  const invalid = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec(), readContainerArtifact: async () => '{', copyArtifact: async () => {},
  });
  const envelopeMissing = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec(), readContainerArtifact: async () => '{}', copyArtifact: async () => {},
  });
  assert.equal(missing.failureCategory, 'artifact_missing_after_poll');
  assert.equal(invalid.failureCategory, 'artifact_unparseable');
  assert.equal(envelopeMissing.failureCategory, 'artifact_terminal_envelope_missing');
});

test('a nonzero docker exec does not discard a successfully copied terminal artifact', async () => {
  const result = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec({ exitCode: 1, stderrPresent: true }),
    readContainerArtifact: async () => terminalArtifact,
    copyArtifact: async () => {},
  });
  assert.equal(result.status, 'artifact_available_exec_nonzero');
  assert.equal(result.copyStatus, 'copied');
  assert.equal(result.dockerExec.stderrPresent, true);
});

test('terminal artifact succeeds even when stdout is absent', async () => {
  const result = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec({ stdoutPresent: false }),
    readContainerArtifact: async () => terminalArtifact,
    copyArtifact: async () => {},
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.dockerExec.stdoutPresent, false);
});

test('outer timeout and copy failures remain separately classified', async () => {
  const timeout = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec({ timedOut: true }), readContainerArtifact: async () => null, copyArtifact: async () => {}, maxPolls: 0,
  });
  const copyFailure = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec(), readContainerArtifact: async () => terminalArtifact, copyArtifact: async () => { throw new Error('copy failed'); },
  });
  assert.equal(timeout.failureCategory, 'outer_timeout_artifact_missing');
  assert.equal(copyFailure.failureCategory, 'docker_copy_failure');
});

test('inspection exposes only terminal-envelope metadata', () => {
  const observation = inspectTerminalArtifact(terminalArtifact);
  assert.deepEqual(observation, { status: 'available', terminalStatus: 'complete', artifactWriteFinished: true, atomicRenameStatus: 'success' });
  assert.doesNotMatch(JSON.stringify(observation), /prompt|output|token|secret/i);
});

test('observation never returns raw artifact fields', async () => {
  const artifactWithSensitiveFields = JSON.stringify({
    terminalStatus: 'complete',
    pilot: { terminalStatus: 'complete', records: [{ email: 'person@example.invalid', token: 'private-value' }] },
    aggregate: { status: 'complete' },
    artifactWriteFinished: true,
    atomicRenameStatus: 'success',
  });
  const result = await observeAndCopyPilotArtifact({
    executeDocker: async () => dockerExec(),
    readContainerArtifact: async () => artifactWithSensitiveFields,
    copyArtifact: async () => {},
  });
  assert.equal(result.status, 'complete');
  assert.doesNotMatch(JSON.stringify(result), /person@example|private-value|email|token/i);
});
