'use strict';

function normalizeDockerExec(result = {}) {
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    signal: typeof result.signal === 'string' ? result.signal : null,
    stderrPresent: result.stderrPresent === true,
    stdoutPresent: result.stdoutPresent === true,
    timedOut: result.timedOut === true,
  };
}

function inspectTerminalArtifact(serialized) {
  if (serialized === null || serialized === undefined) return { status: 'missing' };
  if (typeof serialized !== 'string') return { status: 'unparseable' };

  let report;
  try {
    report = JSON.parse(serialized);
  } catch {
    return { status: 'unparseable' };
  }

  const terminalEnvelope = typeof report?.terminalStatus === 'string'
    && typeof report?.pilot?.terminalStatus === 'string'
    && typeof report?.aggregate?.status === 'string';
  if (!terminalEnvelope) return { status: 'terminal_envelope_missing' };

  return {
    status: 'available',
    terminalStatus: report.terminalStatus,
    artifactWriteFinished: report.artifactWriteFinished === true,
    atomicRenameStatus: typeof report.atomicRenameStatus === 'string' ? report.atomicRenameStatus : null,
  };
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unavailableResult({ dockerExec, artifactObservation, pollCount, failureCategory }) {
  return {
    schemaVersion: '1.0',
    kind: 'pilot_container_artifact_observation',
    status: 'artifact_unavailable',
    failureCategory,
    dockerExec,
    artifactObservation: { ...artifactObservation, pollCount },
    copyStatus: 'not_attempted',
  };
}

async function observeAndCopyPilotArtifact({
  executeDocker,
  readContainerArtifact,
  copyArtifact,
  maxPolls = 4,
  pollIntervalMs = 250,
  wait = waitFor,
} = {}) {
  if (typeof executeDocker !== 'function' || typeof readContainerArtifact !== 'function' || typeof copyArtifact !== 'function') {
    throw new TypeError('execution, observation, and copy adapters are required');
  }

  let dockerExec;
  try {
    dockerExec = normalizeDockerExec(await executeDocker());
  } catch {
    dockerExec = normalizeDockerExec({ exitCode: null, signal: null, stderrPresent: false, stdoutPresent: false, timedOut: false });
    return unavailableResult({ dockerExec, artifactObservation: { status: 'not_observed' }, pollCount: 0, failureCategory: 'docker_exec_observation_failure' });
  }

  let artifactObservation = { status: 'missing' };
  let pollCount = 0;
  for (; pollCount <= maxPolls; pollCount += 1) {
    try {
      artifactObservation = inspectTerminalArtifact(await readContainerArtifact());
    } catch {
      artifactObservation = { status: 'read_failure' };
    }
    if (artifactObservation.status !== 'missing') break;
    if (pollCount < maxPolls) await wait(pollIntervalMs);
  }

  if (artifactObservation.status !== 'available') {
    const failureCategory = artifactObservation.status === 'missing'
      ? (dockerExec.timedOut ? 'outer_timeout_artifact_missing' : 'artifact_missing_after_poll')
      : `artifact_${artifactObservation.status}`;
    return unavailableResult({ dockerExec, artifactObservation, pollCount, failureCategory });
  }

  try {
    await copyArtifact();
  } catch {
    return {
      schemaVersion: '1.0',
      kind: 'pilot_container_artifact_observation',
      status: 'artifact_available_copy_failed',
      failureCategory: 'docker_copy_failure',
      dockerExec,
      artifactObservation: { ...artifactObservation, pollCount },
      copyStatus: 'failure',
    };
  }

  const execNonzero = dockerExec.exitCode !== null && dockerExec.exitCode !== 0;
  return {
    schemaVersion: '1.0',
    kind: 'pilot_container_artifact_observation',
    status: execNonzero || dockerExec.signal || dockerExec.timedOut ? 'artifact_available_exec_nonzero' : 'complete',
    failureCategory: null,
    dockerExec,
    artifactObservation: { ...artifactObservation, pollCount },
    copyStatus: 'copied',
  };
}

module.exports = { inspectTerminalArtifact, normalizeDockerExec, observeAndCopyPilotArtifact };
