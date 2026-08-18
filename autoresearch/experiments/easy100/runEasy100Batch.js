'use strict';

// This runner deliberately never creates or executes an n8n workflow. It
// measures generation and static execution readiness only; actual execution
// evidence is a separate, explicitly controlled phase.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseJsonCandidate, safeContentType, availabilityFailure } = require('../../../chatbot/tests/modelBenchmark/createJsonPolicy');
const { verifyCandidateWorkflow } = require('../../../chatbot/src/candidateWorkflowVerifier');

const DEFAULT_MODEL = 'qwen2.5-coder-32b-ft-original:latest';
const DEFAULT_TIMEOUT_MS = 120000;
const STOP_AFTER_AVAILABILITY_FAILURES = 2;
const SYSTEM_INSTRUCTION = [
  'Generate one importable n8n workflow JSON object for the user request.',
  'Return JSON only. Use the documented n8n node type and parameter shapes.',
  'Never embed credential values or API keys. When an external account is required, leave it for user setup.',
  'In Code nodes, $input.all() items are wrappers: read business data via item.json.<field> or explicitly normalize item.json first.',
  'Use a serial topology when a Code node needs values from more than one upstream node unless the runtime proves a fan-in barrier.',
].join('\n');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isoNow() {
  return new Date().toISOString();
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`invalid JSONL at line ${index + 1}`); }
  });
}

function userDescription(record) {
  const message = Array.isArray(record?.messages) ? record.messages.find((entry) => entry?.role === 'user') : null;
  if (!message || typeof message.content !== 'string' || !message.content.trim()) throw new Error(`case ${record?.id ?? 'unknown'} has no user description`);
  return message.content.trim();
}

function loadEasyCases(inputPath, limit = 100) {
  const source = readJsonLines(inputPath);
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  return source.slice(0, limit).map((record, index) => ({
    caseId: String(record?.id ?? index),
    description: userDescription(record),
  }));
}

function createRequest({ model, description }) {
  return {
    model,
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: description },
    ],
  };
}

function safeCapabilitySummary(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const usesCredentials = nodes.some((node) => node?.credentials && typeof node.credentials === 'object' && Object.keys(node.credentials).length > 0);
  const types = nodes.map((node) => String(node?.type || '').toLowerCase());
  const writesExternally = types.some((type) => /(slack|gmail|email|telegram|google|notion|drive|sheets|discord|twitter|facebook|stripe|database|webhook)/.test(type));
  const hasCode = types.some((type) => type.endsWith('.code') || type === 'code');
  return { usesCredentials, writesExternally, hasCode };
}

function readinessFrom({ parsed, verification, capability }) {
  if (!parsed.ok) return { category: 'not_parseable', actualExecution: 'not_attempted' };
  if (!verification || verification.status === 'repair' || verification.status === 'clarify') return { category: 'static_blocked', actualExecution: 'not_attempted' };
  if (capability.usesCredentials || capability.writesExternally) return { category: 'requires_user_setup', actualExecution: 'not_attempted' };
  if (capability.hasCode) return { category: 'sandbox_required', actualExecution: 'not_attempted' };
  return { category: 'eligible_for_controlled_execution', actualExecution: 'not_attempted' };
}

function findingCategoryCounts(verification) {
  const counts = {};
  for (const finding of verification?.findings || []) {
    const key = typeof finding?.category === 'string' ? finding.category : 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function safeHttpTelemetry(response) {
  return {
    httpStatus: Number.isInteger(response?.status) ? response.status : null,
    contentType: safeContentType(response?.headers?.get?.('content-type')),
  };
}

async function generateOne({ fetchImpl = globalThis.fetch, env = process.env, model, description, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const baseUrl = String(env.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
      method: 'POST', headers, signal: controller.signal, body: JSON.stringify(createRequest({ model, description })),
    });
    if (!response.ok) throw { kind: 'http_failure', telemetry: safeHttpTelemetry(response) };
    const payload = await response.json();
    return {
      rawOutput: payload?.choices?.[0]?.message?.content ?? '',
      telemetry: safeHttpTelemetry(response),
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw { kind: 'timeout' };
    throw error?.kind ? error : { kind: 'transport' };
  } finally {
    clearTimeout(timer);
  }
}

function verifyStatic(workflow, description) {
  return verifyCandidateWorkflow({ operation: 'create', userRequest: description, candidateWorkflow: workflow });
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function appendPrivatePrediction(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function aggregate(records, planned) {
  const categories = {};
  const findings = {};
  for (const record of records) {
    categories[record.executionReadiness.category] = (categories[record.executionReadiness.category] || 0) + 1;
    for (const [category, count] of Object.entries(record.findingCategories)) findings[category] = (findings[category] || 0) + count;
  }
  const count = (predicate) => records.filter(predicate).length;
  return {
    plannedCases: planned,
    attemptedCases: records.length,
    generationCompleted: count((record) => record.outcome === 'completed'),
    availabilityFailures: count((record) => record.outcome === 'availability_failure'),
    strictJsonPass: count((record) => record.strictJsonStatus === 'pass'),
    repairedJsonPass: count((record) => record.repairedJsonStatus === 'pass'),
    staticPass: count((record) => record.staticStatus === 'pass' || record.staticStatus === 'warning'),
    executionReadiness: categories,
    actualExecution: { attempted: 0, passed: 0, failed: 0, notAttempted: records.length },
    findingCategories: findings,
  };
}

async function runEasy100Batch({ inputPath, outputDir, limit = 100, model = process.env.CREATE_BATCH_MODEL || DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, generate = generateOne, verify = verifyStatic } = {}) {
  if (!inputPath || !outputDir) throw new TypeError('inputPath and outputDir are required');
  const cases = loadEasyCases(inputPath, limit);
  const reportPath = path.join(outputDir, 'execution-readiness-report.json');
  const privatePredictionsPath = path.join(outputDir, 'private', 'predictions.jsonl');
  const records = [];
  let consecutiveAvailabilityFailures = 0;
  for (const testCase of cases) {
    if (consecutiveAvailabilityFailures >= STOP_AFTER_AVAILABILITY_FAILURES) break;
    const startedAt = isoNow();
    const startedMs = Date.now();
    let record;
    try {
      const generated = await generate({ fetchImpl, model, description: testCase.description, timeoutMs });
      const parsed = parseJsonCandidate(generated.rawOutput);
      let verification = null;
      let capability = { usesCredentials: false, writesExternally: false, hasCode: false };
      if (parsed.ok) {
        verification = await verify(parsed.value, testCase.description);
        capability = safeCapabilitySummary(parsed.value);
        appendPrivatePrediction(privatePredictionsPath, { id: testCase.caseId, predicted: parsed.value });
      }
      record = {
        caseId: testCase.caseId,
        startedAt,
        completedAt: isoNow(),
        latencyMs: Date.now() - startedMs,
        outcome: 'completed',
        httpStatus: generated.telemetry.httpStatus,
        contentType: generated.telemetry.contentType,
        strictJsonStatus: parsed.strictJsonStatus,
        repairedJsonStatus: parsed.repairedJsonStatus,
        outputCategory: parsed.outputCategory,
        staticStatus: verification?.status || 'not_run',
        findingCategories: findingCategoryCounts(verification),
        capability,
        executionReadiness: readinessFrom({ parsed, verification, capability }),
      };
      consecutiveAvailabilityFailures = 0;
    } catch (error) {
      const kind = availabilityFailure(error);
      record = {
        caseId: testCase.caseId,
        startedAt,
        completedAt: isoNow(),
        latencyMs: Date.now() - startedMs,
        outcome: 'availability_failure',
        failureCategory: kind,
        httpStatus: Number.isInteger(error?.telemetry?.httpStatus) ? error.telemetry.httpStatus : null,
        contentType: error?.telemetry?.contentType || 'other_or_unavailable',
        strictJsonStatus: 'not_run',
        repairedJsonStatus: 'not_run',
        outputCategory: kind,
        staticStatus: 'not_run',
        findingCategories: {},
        capability: { usesCredentials: false, writesExternally: false, hasCode: false },
        executionReadiness: { category: 'generation_unavailable', actualExecution: 'not_attempted' },
      };
      consecutiveAvailabilityFailures += 1;
    }
    records.push(record);
    atomicWrite(reportPath, {
      schemaVersion: '1.0', kind: 'easy100_execution_readiness_report', status: records.length === cases.length ? 'complete' : 'partial',
      model, inputFingerprint: sha256(fs.readFileSync(inputPath, 'utf8')), promptFingerprint: sha256(SYSTEM_INSTRUCTION),
      semanticReview: 'not_run', executionPolicy: 'no_n8n_create_or_execution', records, aggregate: aggregate(records, cases.length),
    });
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function main() {
  const inputPath = process.env.EASY100_INPUT_PATH;
  const outputDir = process.env.EASY100_OUTPUT_DIR;
  runEasy100Batch({ inputPath, outputDir }).then((report) => {
    process.stdout.write(JSON.stringify({ status: report.status, aggregate: report.aggregate }) + '\n');
  }).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { DEFAULT_MODEL, SYSTEM_INSTRUCTION, aggregate, createRequest, loadEasyCases, readinessFrom, runEasy100Batch, safeCapabilitySummary, userDescription };
