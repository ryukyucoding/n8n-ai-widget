'use strict';

const { availabilityFailure, parseJsonCandidate, safeContentType } = require('./createJsonPolicy');
const { SAFE_FINDING_CLASSES, emptyStaticFindingSummary, mergeStaticFindingSummaries, summarizeStaticFindings } = require('./safeStaticFindingSummary');

const FORBIDDEN_REPORT_KEYS = /^(?:authorization|credential|token|api[_-]?key|password|secret|endpoint|host|workflow(?:id|json)?|raw(?:prompt|modeloutput|output)?)$/i;

function nowIso(now) {
  return new Date(typeof now === 'function' ? now() : Date.now()).toISOString();
}

function findingCounts(findings) {
  const summary = summarizeStaticFindings(findings);
  return Object.fromEntries(SAFE_FINDING_CLASSES.filter((kind) => summary[kind].count > 0).map((kind) => [kind, summary[kind].count]));
}

function verificationMetrics(verification) {
  const structural = verification?.verification?.structural?.status || 'not_run';
  const dataflow = verification?.verification?.dataflow?.status || 'not_run';
  const semantic = verification?.verification?.semantic?.status || 'not_run';
  const status = verification?.status || 'repair';
  return {
    runtimeSchemaStatus: structural,
    connectionPortStatus: structural,
    mustExecuteBeforeStatus: dataflow,
    semanticReviewStatus: semantic,
    firstCandidatePass: status === 'pass' || status === 'warning',
    repairNeeded: status === 'repair',
    findingCounts: findingCounts(verification?.findings),
    staticFindingSummary: summarizeStaticFindings(verification?.findings),
  };
}

function emptyChildTelemetry() {
  return { childSpawnStatus: 'not_run', childExitCode: null, childSignal: null, stderrPresent: false };
}

function normalizeChildTelemetry(value) {
  return {
    childSpawnStatus: ['not_run', 'not_observed', 'spawned', 'spawn_failure'].includes(value?.childSpawnStatus) ? value.childSpawnStatus : 'not_observed',
    childExitCode: Number.isInteger(value?.childExitCode) ? value.childExitCode : null,
    childSignal: typeof value?.childSignal === 'string' ? value.childSignal : null,
    stderrPresent: value?.stderrPresent === true,
  };
}

function normalizeRequestTelemetry(value, resolved) {
  return {
    requestDispatchStarted: value?.requestDispatchStarted === false ? false : true,
    responseReceived: value?.responseReceived === true || (resolved && value?.responseReceived !== false),
    httpStatus: Number.isInteger(value?.httpStatus) ? value.httpStatus : null,
    safeContentTypeCategory: safeContentType(value?.contentType),
    contentType: safeContentType(value?.contentType),
  };
}

function isPassingStatus(status) {
  return status === 'pass' || status === 'warning';
}

function isAvailabilityOutcome(outcome) {
  return outcome === 'timeout' || outcome === 'availability_failure';
}

function rate(records, predicate) {
  if (!records.length) return null;
  return Number((records.filter(predicate).length / records.length).toFixed(6));
}

function latencySummary(records) {
  const values = records.map((record) => record.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return { minMs: null, medianMs: null, maxMs: null };
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return { minMs: values[0], medianMs: median, maxMs: values[values.length - 1] };
}

function aggregateFindingCounts(records) {
  const counts = {};
  for (const record of records) {
    for (const [category, count] of Object.entries(record.findingCounts || {})) counts[category] = (counts[category] || 0) + count;
  }
  return counts;
}

function aggregatePilotReport(report) {
  const records = Array.isArray(report?.records) ? report.records : [];
  const plannedRuns = Number.isInteger(report?.plannedRuns) ? report.plannedRuns : records.length;
  const cases = [...new Set(records.map((record) => record.caseId))].sort();
  const availabilityFailureCount = records.filter((record) => isAvailabilityOutcome(record.outcome)).length;
  return {
    schemaVersion: '1.1',
    kind: 'create_model_pilot_aggregate',
    candidateSlot: records[0]?.candidateSlot || null,
    modelTag: records[0]?.modelTag || null,
    status: report?.incomplete ? 'incomplete' : (availabilityFailureCount ? 'partial_availability' : 'complete'),
    totalRuns: plannedRuns,
    attemptedRuns: records.length,
    completedRuns: records.filter((record) => record.outcome === 'completed').length,
    incompleteRuns: Math.max(0, plannedRuns - records.length),
    incomplete: Boolean(report?.incomplete),
    availabilityFailureCount,
    latencyMs: latencySummary(records),
    strictJsonPassRate: rate(records, (record) => record.strictJsonStatus === 'pass'),
    repairedJsonPassRate: rate(records, (record) => record.repairedJsonStatus === 'pass'),
    runtimeSchemaPassRate: rate(records, (record) => isPassingStatus(record.runtimeSchemaStatus)),
    connectionPortPassRate: rate(records, (record) => isPassingStatus(record.connectionPortStatus)),
    mustExecuteBeforePassRate: rate(records, (record) => isPassingStatus(record.mustExecuteBeforeStatus)),
    semanticReviewStatus: 'not_run',
    staticFindingSummary: mergeStaticFindingSummaries(records.map((record) => record.staticFindingSummary)),
    perCase: cases.map((caseId) => {
      const caseRecords = records.filter((record) => record.caseId === caseId);
      return { caseId, attemptedRuns: caseRecords.length, passRuns: caseRecords.filter((record) => record.firstCandidatePass).length, failRuns: caseRecords.filter((record) => !record.firstCandidatePass).length, availabilityFailureCount: caseRecords.filter((record) => isAvailabilityOutcome(record.outcome)).length, findingCounts: aggregateFindingCounts(caseRecords), staticFindingSummary: mergeStaticFindingSummaries(caseRecords.map((record) => record.staticFindingSummary)) };
    }),
  };
}

function createReadinessRequest() {
  return 'Return only a valid n8n workflow JSON for a Manual Trigger only workflow: exactly one Manual Trigger node and no other nodes, credentials, network calls, or workflow execution.';
}

function ensureSafeReport(value, seen = new Set()) {
  if (Array.isArray(value)) return value.every((item) => ensureSafeReport(item, seen));
  if (!value || typeof value !== 'object') return typeof value !== 'bigint';
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).every(([key, nested]) => !FORBIDDEN_REPORT_KEYS.test(key) && ensureSafeReport(nested, seen));
}

async function runReadinessChecks({ candidates, generate, timeoutMs = 120000, now } = {}) {
  const reports = [];
  for (const candidate of candidates || []) {
    const invocationStartedAt = nowIso(now);
    const started = Date.now();
    let record;
    try {
      const generated = await generate({ candidate, request: createReadinessRequest(), acceptanceContract: null, timeoutMs, mode: 'readiness' });
      const parsed = parseJsonCandidate(generated?.rawOutput);
      record = { candidateSlot: candidate.slot, modelTag: candidate.modelTag, invocationStartedAt, latencyMs: Date.now() - started, terminalStatus: parsed.ok ? 'completed' : 'invalid_output', outcome: parsed.ok ? 'completed' : 'invalid_output', ...normalizeRequestTelemetry(generated?.telemetry || generated, true), timeout: false, availabilityFailureCategory: null, outputCategory: parsed.outputCategory, strictJsonStatus: parsed.strictJsonStatus, repairedJsonStatus: parsed.repairedJsonStatus };
    } catch (error) {
      const failureKind = availabilityFailure(error);
      record = { candidateSlot: candidate.slot, modelTag: candidate.modelTag, invocationStartedAt, latencyMs: Date.now() - started, terminalStatus: failureKind === 'timeout' ? 'timeout' : 'availability_failure', outcome: failureKind === 'timeout' ? 'timeout' : 'availability_failure', ...normalizeRequestTelemetry(error?.telemetry || error, false), timeout: failureKind === 'timeout', availabilityFailureCategory: failureKind, outputCategory: failureKind, strictJsonStatus: 'not_run', repairedJsonStatus: 'not_run' };
    } finally {
      record = record || { candidateSlot: candidate.slot, modelTag: candidate.modelTag, invocationStartedAt, latencyMs: Date.now() - started, terminalStatus: 'runner_failure', outcome: 'availability_failure', ...normalizeRequestTelemetry(null, false), timeout: false, availabilityFailureCategory: 'transport_error', outputCategory: 'transport_error', strictJsonStatus: 'not_run', repairedJsonStatus: 'not_run' };
      record.invocationFinishedAt = nowIso(now);
      reports.push(record);
    }
  }
  return { schemaVersion: '1.1', kind: 'create_model_readiness', reports };
}

async function runCreateModelPilot({ candidates, cases, generate, verifyStatic, repeats = 3, timeoutMs = 120000, now, stopAfterConsecutiveAvailabilityFailures = Infinity } = {}) {
  if (!Number.isInteger(repeats) || repeats < 1) throw new TypeError('repeats must be a positive integer');
  if (typeof generate !== 'function' || typeof verifyStatic !== 'function') throw new TypeError('generate and verifyStatic must be functions');
  if (!(stopAfterConsecutiveAvailabilityFailures === Infinity || (Number.isInteger(stopAfterConsecutiveAvailabilityFailures) && stopAfterConsecutiveAvailabilityFailures > 0))) throw new TypeError('stopAfterConsecutiveAvailabilityFailures must be a positive integer or Infinity');
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const caseList = Array.isArray(cases) ? cases : [];
  const records = [];
  let consecutiveAvailabilityFailures = 0;
  let incomplete = false;
  pilotLoop: for (const candidate of candidateList) {
    for (const testCase of caseList) {
      for (let runNumber = 1; runNumber <= repeats; runNumber += 1) {
        if (consecutiveAvailabilityFailures >= stopAfterConsecutiveAvailabilityFailures) { incomplete = true; break pilotLoop; }
        const invocationStartedAt = nowIso(now);
        const started = Date.now();
        const base = { candidateSlot: candidate.slot, modelTag: candidate.modelTag, caseId: testCase.caseId, runNumber, invocationStartedAt, latencyMs: 0, candidateCount: 1, executionEvidenceStatus: testCase.executionEvidencePolicy === 'safe_execution_assertion' ? 'not_run' : 'skipped', ...normalizeRequestTelemetry(null, false), timeout: false, availabilityFailureCategory: null, ...emptyChildTelemetry() };
        let record;
        let generated;
        try {
          generated = await generate({ candidate, request: testCase.userRequest, acceptanceContract: testCase.acceptanceContract, testCase, timeoutMs, mode: 'pilot' });
          Object.assign(base, normalizeRequestTelemetry(generated?.telemetry || generated, true));
          base.candidateCount = Number.isInteger(generated?.candidateCount) ? generated.candidateCount : 1;
          const parsed = parseJsonCandidate(generated?.rawOutput);
          if (!parsed.ok) {
            record = { ...base, terminalStatus: 'invalid_output', outcome: 'invalid_output', failureStage: 'json_parse', outputCategory: parsed.outputCategory, strictJsonStatus: parsed.strictJsonStatus, repairedJsonStatus: parsed.repairedJsonStatus, runtimeSchemaStatus: 'not_run', connectionPortStatus: 'not_run', mustExecuteBeforeStatus: 'not_run', semanticReviewStatus: 'not_run', firstCandidatePass: false, repairNeeded: true, findingCounts: {}, staticFindingSummary: emptyStaticFindingSummary() };
            consecutiveAvailabilityFailures = 0;
          } else {
            const staticResult = await verifyStatic({ candidate: parsed.value, testCase });
            const verification = staticResult?.result || staticResult;
            const childTelemetry = normalizeChildTelemetry(staticResult?.childTelemetry);
            record = { ...base, ...childTelemetry, terminalStatus: 'completed', outcome: 'completed', failureStage: 'none', outputCategory: parsed.outputCategory, strictJsonStatus: parsed.strictJsonStatus, repairedJsonStatus: parsed.repairedJsonStatus, ...verificationMetrics(verification) };
            consecutiveAvailabilityFailures = 0;
          }
        } catch (error) {
          const fromStaticVerifier = Boolean(generated);
          const failureKind = availabilityFailure(error);
          if (fromStaticVerifier && error?.kind === 'static_verifier_failure') {
            record = { ...base, ...normalizeChildTelemetry(error.childTelemetry), terminalStatus: 'verification_failure', outcome: 'verification_failure', failureStage: 'static_verifier', outputCategory: 'static_verifier_failure', strictJsonStatus: 'pass', repairedJsonStatus: 'pass', runtimeSchemaStatus: 'repair', connectionPortStatus: 'repair', mustExecuteBeforeStatus: 'not_run', semanticReviewStatus: 'not_run', firstCandidatePass: false, repairNeeded: true, findingCounts: {}, staticFindingSummary: summarizeStaticFindings([{ ruleId: 'structural.verifier_failure', severity: 'fail' }]) };
            consecutiveAvailabilityFailures = 0;
          } else {
            Object.assign(base, normalizeRequestTelemetry(error?.telemetry || error, false));
            record = { ...base, ...normalizeChildTelemetry(error?.childTelemetry), terminalStatus: failureKind === 'timeout' ? 'timeout' : 'availability_failure', outcome: failureKind === 'timeout' ? 'timeout' : 'availability_failure', failureStage: failureKind, outputCategory: failureKind, strictJsonStatus: 'not_run', repairedJsonStatus: 'not_run', runtimeSchemaStatus: 'not_run', connectionPortStatus: 'not_run', mustExecuteBeforeStatus: 'not_run', semanticReviewStatus: 'not_run', firstCandidatePass: false, repairNeeded: false, findingCounts: {}, staticFindingSummary: emptyStaticFindingSummary() };
            record.timeout = failureKind === 'timeout';
            record.availabilityFailureCategory = failureKind;
            consecutiveAvailabilityFailures += 1;
          }
        } finally {
          record = record || { ...base, terminalStatus: 'runner_failure', outcome: 'verification_failure', failureStage: 'runner', outputCategory: 'runner_failure', strictJsonStatus: 'not_run', repairedJsonStatus: 'not_run', runtimeSchemaStatus: 'not_run', connectionPortStatus: 'not_run', mustExecuteBeforeStatus: 'not_run', semanticReviewStatus: 'not_run', firstCandidatePass: false, repairNeeded: false, findingCounts: {}, staticFindingSummary: emptyStaticFindingSummary() };
          record.latencyMs = Date.now() - started;
          record.invocationFinishedAt = nowIso(now);
          records.push(record);
        }
      }
    }
  }
  const report = { schemaVersion: '1.1', kind: 'create_model_pilot', terminalStatus: incomplete ? 'incomplete' : 'complete', repeats, plannedRuns: candidateList.length * caseList.length * repeats, incomplete, records };
  if (!ensureSafeReport(report)) throw new Error('pilot report contains a forbidden field');
  return report;
}

module.exports = { aggregatePilotReport, createReadinessRequest, emptyChildTelemetry, ensureSafeReport, normalizeChildTelemetry, parseJsonCandidate, runCreateModelPilot, runReadinessChecks };
