'use strict';

// Bounded research-only workflow engineer loop. It uses the current runtime
// cards and static verifier, but never creates or executes an n8n workflow.

const fs = require('node:fs');
const path = require('node:path');
const { parseJsonCandidate, availabilityFailure, safeContentType } = require('../../chatbot/tests/modelBenchmark/createJsonPolicy');
const {
  findingCategoryCounts, loadEasyCases, readinessFrom, safeCapabilitySummary,
  safeHttpFailureCategory, verifyStatic,
} = require('../experiments/easy100/runEasy100Batch');
const { buildRuntimePlanningContext, buildRuntimeRepairContext, planningContextStats } = require('../planning/runtimeSchemaCatalog');

const DEFAULT_AGENT_MODEL = 'qwen3.8:27b';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_ATTEMPTS = 2;

const WORKFLOW_ENGINEER_SYSTEM = [
  'You are a runtime-aware n8n Workflow Engineer.',
  'Return one complete n8n workflow JSON object only.',
  'Use only the supplied installed runtime node cards and their exact typeVersion values.',
  'Do not include credentials, API keys, OAuth values, or prose.',
  'Respect every explicit node requirement in the user request.',
].join(' ');

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function safeCandidateForRepair(workflow) {
  const copy = JSON.parse(JSON.stringify(workflow));
  for (const node of Array.isArray(copy?.nodes) ? copy.nodes : []) delete node.credentials;
  return copy;
}

function initialMessages({ description, runtimeContext }) {
  return [
    { role: 'system', content: WORKFLOW_ENGINEER_SYSTEM },
    { role: 'user', content: description },
    { role: 'user', content: JSON.stringify(runtimeContext) },
  ];
}

function buildRepairInstructions({ candidate, repairContext, findingCategories }) {
  const allowedCards = Array.isArray(repairContext?.candidateNodes) ? repairContext.candidateNodes : [];
  const allowedByIdentity = new Set(allowedCards.map((node) => `${node.type}@${node.typeVersion}`));
  const incompatibleNodes = (Array.isArray(candidate?.nodes) ? candidate.nodes : [])
    .map((node, nodeIndex) => ({ node, nodeIndex }))
    .filter(({ node }) => !allowedByIdentity.has(`${node?.type}@${node?.typeVersion}`))
    .map(({ node, nodeIndex }) => ({
      nodeIndex,
      candidateType: typeof node?.type === 'string' ? node.type : null,
      candidateTypeVersion: Number.isFinite(Number(node?.typeVersion)) ? Number(node.typeVersion) : null,
      requiredAction: 'replace_with_an_allowed_runtime_card',
    }));
  return {
    findingCategories,
    incompatibleNodes,
    rules: [
      'Preserve the user-requested behavior and repair the existing workflow instead of redesigning it.',
      'Replace every incompatible node with an allowed runtime card before changing connections.',
      'For retained nodes, remove parameter names not listed on that node card and set the card exact typeVersion.',
      'Never add credentials, API keys, OAuth values, or prose.',
    ],
  };
}

function repairMessages({ description, repairContext, candidate, repairInstructions }) {
  return [
    { role: 'system', content: WORKFLOW_ENGINEER_SYSTEM },
    { role: 'user', content: description },
    { role: 'user', content: JSON.stringify(repairContext) },
    { role: 'user', content: `Repair this candidate using the repair contract and instructions below. Return the complete repaired workflow JSON only.\n${JSON.stringify(repairInstructions)}\n${JSON.stringify(safeCandidateForRepair(candidate))}` },
  ];
}

async function callWorkflowAgent({ messages, model, reasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, env = process.env }) {
  const baseUrl = String(env.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const requestBody = { model, temperature: 0, max_tokens: 4096, messages };
    if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) requestBody.reasoning_effort = reasoningEffort.trim();
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
    const telemetry = { httpStatus: Number.isInteger(response?.status) ? response.status : null, contentType: safeContentType(response?.headers?.get?.('content-type')) };
    if (!response.ok) {
      let body = null;
      try { body = await response.text(); } catch {}
      throw { kind: 'http_failure', telemetry: { ...telemetry, safeFailureCategory: safeHttpFailureCategory(body) } };
    }
    const payload = await response.json();
    return { rawOutput: payload?.choices?.[0]?.message?.content ?? '', telemetry };
  } catch (error) {
    if (error?.name === 'AbortError') throw { kind: 'timeout' };
    throw error?.kind ? error : { kind: 'transport' };
  } finally {
    clearTimeout(timer);
  }
}

function safeAttempt({ attempt, generated, parsed, verification, capability }) {
  return {
    attempt,
    httpStatus: generated.telemetry.httpStatus,
    contentType: generated.telemetry.contentType,
    outputCategory: parsed.outputCategory,
    strictJsonStatus: parsed.strictJsonStatus,
    repairedJsonStatus: parsed.repairedJsonStatus,
    staticStatus: verification?.status || 'repair',
    findingCategories: findingCategoryCounts(verification),
    executionReadiness: readinessFrom({ parsed, verification, capability }).category,
  };
}

async function runRuntimeAwareWorkflowAgent({ inputPath, outputPath, caseIndex = 0, model = DEFAULT_AGENT_MODEL, maxAttempts = DEFAULT_MAX_ATTEMPTS, reasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS, schemaPath, fetchImpl, env, verify = verifyStatic, onParseableCandidate } = {}) {
  if (!inputPath || !outputPath) throw new TypeError('inputPath and outputPath are required');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new TypeError('maxAttempts must be an integer from 1 to 3');
  const testCase = loadEasyCases(inputPath, caseIndex + 1)[caseIndex];
  if (!testCase) throw new Error('requested case is unavailable');
  const runtimeContext = buildRuntimePlanningContext({ userRequest: testCase.description, schemaPath });
  const repairContext = buildRuntimeRepairContext({ runtimeContext, schemaPath });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const attempts = [];
  let latestParseableCandidate = null;
  let messages = initialMessages({ description: testCase.description, runtimeContext });
  let report;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const generated = await callWorkflowAgent({ messages, model, reasoningEffort, timeoutMs, fetchImpl, env });
      const parsed = parseJsonCandidate(generated.rawOutput);
      let verification = null;
      let capability = { usesCredentials: false, writesExternally: false, hasCode: false };
      if (parsed.ok) {
        latestParseableCandidate = parsed.value;
        try {
          verification = await verify(parsed.value, testCase.description);
          capability = safeCapabilitySummary(parsed.value);
        } catch (error) {
          verification = { status: 'repair', findings: Array.isArray(error?.findings) ? error.findings : [] };
        }
      }
      const entry = safeAttempt({ attempt, generated, parsed, verification, capability });
      attempts.push(entry);
      if (parsed.ok && (verification?.status === 'pass' || verification?.status === 'warning')) {
        report = { outcome: 'static_pass', attempts };
        break;
      }
      if (attempt === maxAttempts) {
        report = { outcome: 'static_blocked', attempts };
        break;
      }
      messages = parsed.ok
        ? repairMessages({
          description: testCase.description,
          repairContext,
          candidate: parsed.value,
          repairInstructions: buildRepairInstructions({ candidate: parsed.value, repairContext, findingCategories: entry.findingCategories }),
        })
        : [...initialMessages({ description: testCase.description, runtimeContext }), { role: 'user', content: 'The previous response was not a complete workflow JSON object. Return one complete workflow JSON object only.' }];
    }
  } catch (error) {
    report = {
      outcome: 'agent_unavailable', attempts,
      failureCategory: availabilityFailure(error),
      safeFailureCategory: error?.telemetry?.safeFailureCategory || null,
      httpStatus: Number.isInteger(error?.telemetry?.httpStatus) ? error.telemetry.httpStatus : null,
    };
  }
  const envelope = {
    schemaVersion: '1.0', kind: 'runtime_aware_workflow_agent_preflight', executionPolicy: 'no_n8n_create_or_execution',
    caseId: testCase.caseId, model, maxAttempts, reasoningEffort: reasoningEffort || null, startedAt, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs,
    runtimeContextStats: planningContextStats(runtimeContext), ...report,
  };
  atomicWrite(outputPath, envelope);
  if (latestParseableCandidate && typeof onParseableCandidate === 'function') {
    onParseableCandidate({ caseId: testCase.caseId, candidate: latestParseableCandidate, report: envelope });
  }
  return envelope;
}

function main() {
  runRuntimeAwareWorkflowAgent({
    inputPath: process.env.AGENT_PREFLIGHT_INPUT_PATH,
    outputPath: process.env.AGENT_PREFLIGHT_OUTPUT_PATH,
    caseIndex: Number.parseInt(process.env.AGENT_PREFLIGHT_CASE_INDEX || '0', 10) || 0,
    model: process.env.AGENT_PREFLIGHT_MODEL || DEFAULT_AGENT_MODEL,
    maxAttempts: Number.parseInt(process.env.AGENT_PREFLIGHT_MAX_ATTEMPTS || String(DEFAULT_MAX_ATTEMPTS), 10),
    reasoningEffort: process.env.AGENT_PREFLIGHT_REASONING_EFFORT,
    timeoutMs: Number.parseInt(process.env.AGENT_PREFLIGHT_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
  }).then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { DEFAULT_AGENT_MODEL, buildRepairInstructions, initialMessages, repairMessages, runRuntimeAwareWorkflowAgent, safeCandidateForRepair };
