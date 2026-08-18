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
// Historical Easy-100 S1 runs reached 171 seconds. 180 seconds preserves a
// bounded run while avoiding a timeout that is known to reject valid work.
const DEFAULT_TIMEOUT_MS = 180000;
const STOP_AFTER_AVAILABILITY_FAILURES = 2;
const SAFE_STATIC_CATEGORIES = new Set([
  'node_type', 'type_version', 'parameter_schema', 'parameter_value',
  'connection_port', 'connection_shape', 'code_dataflow',
  'unsupported_metadata', 'payload_sanitization', 'unknown_structural',
]);

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

function messageContent(record, role) {
  const message = Array.isArray(record?.messages) ? record.messages.find((entry) => entry?.role === role) : null;
  return typeof message?.content === 'string' && message.content.trim() ? message.content.trim() : null;
}

function userDescription(record) {
  const content = messageContent(record, 'user');
  if (!content) throw new Error(`case ${record?.id ?? 'unknown'} has no user description`);
  return content;
}

function loadEasyCases(inputPath, limit = 100) {
  const source = readJsonLines(inputPath);
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  return source.slice(0, limit).map((record, index) => ({
    caseId: String(record?.id ?? index),
    description: userDescription(record),
    systemPrompt: messageContent(record, 'system'),
  }));
}

function createRequest({ model, description, systemPrompt, jsonMode = true }) {
  if (!systemPrompt) throw new Error('source system prompt is required for legacy-comparable Easy-100 generation');
  const request = {
    model,
    temperature: 0,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: description },
    ],
  };
  if (jsonMode) request.response_format = { type: 'json_object' };
  return request;
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
    const key = safeFindingCategory(finding);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function safeFindingCategory(finding) {
  const ruleId = typeof finding?.ruleId === 'string' ? finding.ruleId : '';
  const benchmarkMatch = /^benchmark\.([a-z_]+)$/.exec(ruleId);
  if (benchmarkMatch && SAFE_STATIC_CATEGORIES.has(benchmarkMatch[1])) return benchmarkMatch[1];
  if (ruleId.startsWith('dataflow.')) return 'code_dataflow';
  if (ruleId.startsWith('connection.')) return 'connection_port';
  return 'unknown_structural';
}

function safeHttpTelemetry(response) {
  return {
    httpStatus: Number.isInteger(response?.status) ? response.status : null,
    contentType: safeContentType(response?.headers?.get?.('content-type')),
  };
}

function safeHttpFailureCategory(body) {
  const text = typeof body === 'string' ? body.toLowerCase() : '';
  if (/response_format|json_object|json mode/.test(text)) return 'json_mode_rejected';
  if (/context.{0,32}(limit|length)|max_tokens|token.{0,32}(limit|length)/.test(text)) return 'context_limit_rejected';
  if (/out of memory|cuda|resource exhausted/.test(text)) return 'model_capacity_rejected';
  if (/model.{0,48}(not found|unavailable)|unknown model/.test(text)) return 'model_unavailable';
  if (/parameter|request.{0,32}(invalid|error)|invalid.{0,32}request/.test(text)) return 'request_parameter_rejected';
  if (/model/.test(text)) return 'model_request_rejected';
  return 'http_failure_unclassified';
}

async function generateOne({ fetchImpl = globalThis.fetch, env = process.env, model, description, systemPrompt, jsonMode = true, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const baseUrl = String(env.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
      method: 'POST', headers, signal: controller.signal, body: JSON.stringify(createRequest({ model, description, systemPrompt, jsonMode })),
    });
    if (!response.ok) {
      let body = null;
      let bodyReadable = false;
      try { body = await response.text(); bodyReadable = true; } catch {}
      throw {
        kind: 'http_failure',
        telemetry: { ...safeHttpTelemetry(response), bodyReadable, safeFailureCategory: safeHttpFailureCategory(body) },
      };
    }
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

function protocolFindingToVerifierFinding(finding) {
  const category = SAFE_STATIC_CATEGORIES.has(finding?.category) ? finding.category : 'unknown_structural';
  return {
    ruleId: `benchmark.${category}`,
    severity: finding?.severity === 'warning' ? 'warning' : 'repair',
    evidenceSource: 'runtime_schema',
    category: category === 'connection_port' || category === 'connection_shape'
      ? 'connection'
      : (category === 'code_dataflow' ? 'dataflow' : 'node_schema'),
    location: { kind: category },
    message: 'Benchmark structural finding.',
    repairable: finding?.repairable === true,
    normalized: finding?.normalized === true,
  };
}

function createBenchmarkStructuralValidator({ spawn = spawnSync, python = process.env.PYTHON_BIN || 'python3', repairScript = path.join(__dirname, '..', '..', '..', 'chatbot', 'python', 'workflow_repair.py') } = {}) {
  return (input) => {
    const rawCandidate = typeof input.candidateWorkflow === 'string' ? input.candidateWorkflow : JSON.stringify(input.candidateWorkflow);
    const child = spawn(python, [repairScript], {
      input: JSON.stringify({ raw_output: rawCandidate, user_request: input.userRequest, benchmarkStaticProtocol: true }),
      encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 48 * 1024 * 1024,
    });
    if (child.error) throw new Error('benchmark static verifier spawn failed');
    let envelope;
    try { envelope = JSON.parse(String(child.stdout || '').trim()); } catch { throw new Error('benchmark static verifier returned an invalid envelope'); }
    const validEnvelope = typeof envelope?.ok === 'boolean' && Array.isArray(envelope?.findings) && typeof envelope?.unstructuredFailure === 'boolean';
    if (!validEnvelope) throw new Error('benchmark static verifier returned an incomplete envelope');
    const findings = envelope.findings.map(protocolFindingToVerifierFinding);
    if (!envelope.ok || child.status !== 0) {
      const error = new Error('benchmark static verifier rejected the candidate');
      if (findings.length) error.findings = findings;
      throw error;
    }
    return { workflow: input.candidateWorkflow, warnings: [], repairs: {}, findings };
  };
}

function verifyStatic(workflow, description, structuralValidator = createBenchmarkStructuralValidator()) {
  return verifyCandidateWorkflow({ operation: 'create', userRequest: description, candidateWorkflow: workflow }, { structuralValidator });
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

async function runEasy100Batch({ inputPath, outputDir, limit = 100, model = process.env.CREATE_BATCH_MODEL || DEFAULT_MODEL, jsonMode = true, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, generate = generateOne, verify = verifyStatic } = {}) {
  if (!inputPath || !outputDir) throw new TypeError('inputPath and outputDir are required');
  const cases = loadEasyCases(inputPath, limit);
  const reportPath = path.join(outputDir, 'execution-readiness-report.json');
  const privatePredictionsPath = path.join(outputDir, 'private', 'predictions.jsonl');
  const records = [];
  let consecutiveAvailabilityFailures = 0;
  let stopReason = null;
  for (const testCase of cases) {
    if (stopReason === 'timeout') break;
    if (consecutiveAvailabilityFailures >= STOP_AFTER_AVAILABILITY_FAILURES) {
      stopReason = 'consecutive_availability_failures';
      break;
    }
    const startedAt = isoNow();
    const startedMs = Date.now();
    let record;
    try {
      const generated = await generate({ fetchImpl, model, description: testCase.description, systemPrompt: testCase.systemPrompt, jsonMode, timeoutMs });
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
        bodyReadable: error?.telemetry?.bodyReadable === true,
        safeFailureCategory: error?.telemetry?.safeFailureCategory || null,
        strictJsonStatus: 'not_run',
        repairedJsonStatus: 'not_run',
        outputCategory: kind,
        staticStatus: 'not_run',
        findingCategories: {},
        capability: { usesCredentials: false, writesExternally: false, hasCode: false },
        executionReadiness: { category: 'generation_unavailable', actualExecution: 'not_attempted' },
      };
      consecutiveAvailabilityFailures += 1;
      // An abort may leave a remote model server busy briefly. Do not turn one
      // timeout into a second request that is likely to fail misleadingly.
      if (kind === 'timeout') stopReason = 'timeout';
    }
    records.push(record);
    atomicWrite(reportPath, {
      schemaVersion: '1.0', kind: 'easy100_execution_readiness_report', status: records.length === cases.length ? 'complete' : 'partial', stopReason,
      model, jsonMode, inputFingerprint: sha256(fs.readFileSync(inputPath, 'utf8')), generationProtocol: 'source_system_prompt_plus_original_user_description',
      promptFingerprint: sha256([...new Set(cases.map((testCase) => testCase.systemPrompt))].sort().join('\n')),
      semanticReview: 'not_run', executionPolicy: 'no_n8n_create_or_execution', records, aggregate: aggregate(records, cases.length),
    });
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function main() {
  const inputPath = process.env.EASY100_INPUT_PATH;
  const outputDir = process.env.EASY100_OUTPUT_DIR;
  const timeoutMs = Number.parseInt(process.env.EASY100_TIMEOUT_MS || '', 10);
  const limit = Number.parseInt(process.env.EASY100_LIMIT || '', 10);
  const jsonMode = String(process.env.EASY100_JSON_MODE || 'true').toLowerCase() !== 'false';
  runEasy100Batch({ inputPath, outputDir, limit: Number.isInteger(limit) && limit > 0 ? limit : 100, jsonMode, timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS }).then((report) => {
    process.stdout.write(JSON.stringify({ status: report.status, aggregate: report.aggregate }) + '\n');
  }).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { DEFAULT_MODEL, SAFE_STATIC_CATEGORIES, aggregate, createBenchmarkStructuralValidator, createRequest, findingCategoryCounts, loadEasyCases, readinessFrom, runEasy100Batch, safeCapabilitySummary, safeFindingCategory, safeHttpFailureCategory, userDescription, verifyStatic };
