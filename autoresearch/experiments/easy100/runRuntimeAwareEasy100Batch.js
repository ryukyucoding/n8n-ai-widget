'use strict';

// Sequential, resumable Easy-100 measurement for the runtime-aware agent.
// It never calls n8n. Candidate JSON is stored only in the owner-only private
// result folder; the aggregate report contains de-identified outcomes only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEasyCases } = require('./runEasy100Batch');
const { runRuntimeAwareWorkflowAgent, DEFAULT_AGENT_MODEL } = require('../../agent/runRuntimeAwareWorkflowAgent');

const MAX_CONSECUTIVE_UNAVAILABLE = 5;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function appendPrivateCandidate(filePath, { caseId, candidate }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ id: String(caseId), predicted: candidate })}\n`, 'utf8');
}

function safeRecord(report) {
  const lastAttempt = Array.isArray(report?.attempts) ? report.attempts.at(-1) : null;
  return {
    caseId: String(report.caseId),
    outcome: report.outcome,
    latencyMs: Number.isFinite(report.latencyMs) ? report.latencyMs : null,
    failureCategory: typeof report.failureCategory === 'string' ? report.failureCategory : null,
    safeFailureCategory: typeof report.safeFailureCategory === 'string' ? report.safeFailureCategory : null,
    httpStatus: Number.isInteger(report.httpStatus) ? report.httpStatus : (Number.isInteger(lastAttempt?.httpStatus) ? lastAttempt.httpStatus : null),
    strictJsonStatus: typeof lastAttempt?.strictJsonStatus === 'string' ? lastAttempt.strictJsonStatus : 'not_run',
    repairedJsonStatus: typeof lastAttempt?.repairedJsonStatus === 'string' ? lastAttempt.repairedJsonStatus : 'not_run',
    staticStatus: typeof lastAttempt?.staticStatus === 'string' ? lastAttempt.staticStatus : 'not_run',
    findingCategories: lastAttempt?.findingCategories && typeof lastAttempt.findingCategories === 'object' ? lastAttempt.findingCategories : {},
    executionReadiness: typeof lastAttempt?.executionReadiness === 'string' ? lastAttempt.executionReadiness : 'generation_unavailable',
    attemptsUsed: Array.isArray(report?.attempts) ? report.attempts.length : 0,
  };
}

function aggregate(records, plannedCases) {
  const findingCategories = {};
  const readiness = {};
  for (const record of records) {
    readiness[record.executionReadiness] = (readiness[record.executionReadiness] || 0) + 1;
    for (const [category, count] of Object.entries(record.findingCategories)) {
      findingCategories[category] = (findingCategories[category] || 0) + count;
    }
  }
  const count = (predicate) => records.filter(predicate).length;
  return {
    plannedCases,
    attemptedCases: records.length,
    staticPass: count((record) => record.outcome === 'static_pass'),
    staticBlocked: count((record) => record.outcome === 'static_blocked'),
    agentUnavailable: count((record) => record.outcome === 'agent_unavailable'),
    strictJsonPass: count((record) => record.strictJsonStatus === 'pass'),
    repairedJsonPass: count((record) => record.repairedJsonStatus === 'pass'),
    executionReadiness: readiness,
    findingCategories,
  };
}

function readExistingReport(reportPath) {
  if (!fs.existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return Array.isArray(report?.records) ? report : null;
  } catch {
    return null;
  }
}

async function runRuntimeAwareEasy100Batch({ inputPath, outputDir, limit = 100, model = DEFAULT_AGENT_MODEL, maxAttempts = 1, reasoningEffort = 'none', timeoutMs, runOne = runRuntimeAwareWorkflowAgent } = {}) {
  if (!inputPath || !outputDir) throw new TypeError('inputPath and outputDir are required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new TypeError('maxAttempts must be an integer from 1 to 2');
  const cases = loadEasyCases(inputPath, limit);
  const reportPath = path.join(outputDir, 'runtime-aware-easy100-report.json');
  const privateCandidatePath = path.join(outputDir, 'private', 'runtime-aware-predictions.jsonl');
  const existing = readExistingReport(reportPath);
  const records = Array.isArray(existing?.records) ? existing.records : [];
  const completed = new Set(records.map((record) => String(record.caseId)));
  let consecutiveUnavailable = 0;
  let stopReason = null;

  const writeReport = () => {
    const status = stopReason ? 'partial' : (records.length === cases.length ? 'complete' : 'running');
    const report = {
      schemaVersion: '1.0',
      kind: 'runtime_aware_easy100_batch',
      executionPolicy: 'no_n8n_create_or_execution',
      model, maxAttempts, reasoningEffort,
      inputFingerprint: sha256(fs.readFileSync(inputPath, 'utf8')),
      status, stopReason, records, aggregate: aggregate(records, cases.length),
    };
    atomicWrite(reportPath, report);
    return report;
  };

  for (const [caseIndex, testCase] of cases.entries()) {
    if (completed.has(String(testCase.caseId))) continue;
    const perCasePath = path.join(outputDir, 'private', 'case-reports', `${testCase.caseId}.json`);
    const report = await runOne({
      inputPath, outputPath: perCasePath, caseIndex, model, maxAttempts, reasoningEffort, timeoutMs,
      onParseableCandidate: ({ caseId, candidate }) => appendPrivateCandidate(privateCandidatePath, { caseId, candidate }),
    });
    const record = safeRecord(report);
    records.push(record);
    completed.add(String(record.caseId));
    consecutiveUnavailable = record.outcome === 'agent_unavailable' ? consecutiveUnavailable + 1 : 0;
    if (consecutiveUnavailable >= MAX_CONSECUTIVE_UNAVAILABLE) stopReason = 'consecutive_agent_unavailable';
    writeReport();
    if (stopReason) break;
  }
  return writeReport();
}

function main() {
  const parse = (value, fallback) => {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  runRuntimeAwareEasy100Batch({
    inputPath: process.env.EASY100_INPUT_PATH,
    outputDir: process.env.EASY100_OUTPUT_DIR,
    limit: parse(process.env.EASY100_LIMIT, 100),
    model: process.env.RUNTIME_AWARE_MODEL || DEFAULT_AGENT_MODEL,
    maxAttempts: parse(process.env.RUNTIME_AWARE_MAX_ATTEMPTS, 1),
    reasoningEffort: process.env.RUNTIME_AWARE_REASONING_EFFORT || 'none',
    timeoutMs: parse(process.env.RUNTIME_AWARE_TIMEOUT_MS, undefined),
  }).then((report) => process.stdout.write(JSON.stringify({ status: report.status, stopReason: report.stopReason, aggregate: report.aggregate }) + '\n'))
    .catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { aggregate, runRuntimeAwareEasy100Batch, safeRecord };
