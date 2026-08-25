'use strict';

const fs = require('fs');
const path = require('path');
const { ensureSafeReport } = require('./runCreateModelPilot');

function safeFailureCategory(error, fallback) {
  if (error?.code === 'EACCES' || error?.code === 'EROFS' || error?.code === 'ENOSPC') return fallback;
  return fallback;
}

function serializeSanitized(value) {
  const seen = new Set();
  if (!ensureSafeReport(value)) throw Object.assign(new Error('unsafe report'), { kind: 'serialization_failure' });
  return JSON.stringify(value, (key, nested) => {
    if (typeof nested === 'bigint') throw Object.assign(new Error('bigint is not permitted'), { kind: 'serialization_failure' });
    if (nested && typeof nested === 'object') {
      if (seen.has(nested)) throw Object.assign(new Error('circular report is not permitted'), { kind: 'serialization_failure' });
      seen.add(nested);
    }
    return nested;
  });
}

function artifactTelemetry(overrides = {}) {
  return {
    artifactWriteStarted: false,
    artifactWriteFinished: false,
    atomicRenameStatus: 'not_started',
    writeFailureCategory: null,
    ...overrides,
  };
}

function writeSanitizedArtifact({ artifactPath, report, fsOps = fs, tempSuffix = '.tmp' } = {}) {
  const telemetry = artifactTelemetry({ artifactWriteStarted: true });
  if (typeof artifactPath !== 'string' || !artifactPath) return { telemetry: artifactTelemetry({ writeFailureCategory: 'artifact_path_invalid' }), artifactPath: null };
  let encoded;
  try {
    const completedTelemetry = artifactTelemetry({ artifactWriteStarted: true, artifactWriteFinished: true, atomicRenameStatus: 'success' });
    const finalReport = { ...report, ...completedTelemetry, artifactTelemetry: completedTelemetry };
    encoded = serializeSanitized(finalReport);
  } catch (error) {
    return { telemetry: artifactTelemetry({ artifactWriteStarted: true, writeFailureCategory: safeFailureCategory(error, 'serialization_failure') }), artifactPath: null };
  }
  const tempPath = `${artifactPath}${tempSuffix}`;
  try {
    fsOps.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fsOps.writeFileSync(tempPath, encoded, { encoding: 'utf8', mode: 0o600 });
    telemetry.artifactWriteFinished = true;
  } catch (error) {
    return { telemetry: artifactTelemetry({ artifactWriteStarted: true, writeFailureCategory: safeFailureCategory(error, 'temp_write_failure') }), artifactPath: null };
  }
  try {
    fsOps.renameSync(tempPath, artifactPath);
    telemetry.atomicRenameStatus = 'success';
    return { telemetry, artifactPath };
  } catch (error) {
    return { telemetry: artifactTelemetry({ artifactWriteStarted: true, artifactWriteFinished: true, atomicRenameStatus: 'failure', writeFailureCategory: safeFailureCategory(error, 'atomic_rename_failure') }), artifactPath: null };
  }
}

function emitSafeSummary({ stdout = process.stdout, summary } = {}) {
  try {
    stdout.write(`${serializeSanitized(summary)}\n`);
    return 'written';
  } catch {
    return 'write_failure';
  }
}

module.exports = { artifactTelemetry, emitSafeSummary, serializeSanitized, writeSanitizedArtifact };
