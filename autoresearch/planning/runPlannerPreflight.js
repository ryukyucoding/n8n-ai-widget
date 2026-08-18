'use strict';

// One bounded Plan-First check. It calls only the configured planner model;
// it never invokes the Create model, n8n API, or workflow execution.

const fs = require('node:fs');
const path = require('node:path');
const { safeContentType } = require('../../chatbot/tests/modelBenchmark/createJsonPolicy');
const { loadEasyCases, safeHttpFailureCategory } = require('../experiments/easy100/runEasy100Batch');
const { buildRuntimePlanningContext, planningContextStats } = require('./runtimeSchemaCatalog');
const { buildPlanFirstContract, buildRuntimeAwarePlannerMessages } = require('./runtimeAwarePlanner');

const DEFAULT_PLANNER_MODEL = 'gpt-oss:120b';
const DEFAULT_PLANNER_MAX_TOKENS = 700;

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

async function callPlanner({ messages, model, maxTokens = DEFAULT_PLANNER_MAX_TOKENS, reasoningEffort = null, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 120000 }) {
  const baseUrl = String(env.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const requestBody = { model, temperature: 0, max_tokens: maxTokens, messages };
    if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) requestBody.reasoning_effort = reasoningEffort.trim();
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
    const telemetry = { httpStatus: Number.isInteger(response?.status) ? response.status : null, contentType: safeContentType(response?.headers?.get?.('content-type')) };
    if (!response.ok) {
      let body = null;
      let bodyReadable = false;
      try { body = await response.text(); bodyReadable = true; } catch {}
      throw { kind: 'http_failure', telemetry: { ...telemetry, bodyReadable, safeFailureCategory: safeHttpFailureCategory(body) } };
    }
    const payload = await response.json();
    return { rawPlan: payload?.choices?.[0]?.message?.content ?? '', telemetry };
  } catch (error) {
    if (error?.name === 'AbortError') throw { kind: 'timeout' };
    throw error?.kind ? error : { kind: 'transport' };
  } finally {
    clearTimeout(timer);
  }
}

function safePlanSummary({ plan, acceptanceContract, runtimeContext }) {
  return {
    selectedNodeCount: plan.selected_nodes.length,
    allSelectedNodesInRuntimeCatalog: plan.selected_nodes.every((node) => runtimeContext.candidateNodes.some((candidate) => candidate.type === node.type && candidate.typeVersion === node.typeVersion)),
    requiredUserInputCount: plan.required_user_inputs.length,
    requiredConfigurationCount: plan.required_configuration.length,
    outputContractRequired: plan.output_contract_required === true,
    contractConfigurationStatus: acceptanceContract.configurationStatus,
    contractOutputSchemaStatus: acceptanceContract.outputSchema?.status || 'unknown',
  };
}

async function runPlannerPreflight({ inputPath, outputPath, caseIndex = 0, model = DEFAULT_PLANNER_MODEL, maxTokens = DEFAULT_PLANNER_MAX_TOKENS, reasoningEffort = null, timeoutMs = 120000, schemaPath, fetchImpl, env, dryRun = false } = {}) {
  if (!inputPath || !outputPath) throw new TypeError('inputPath and outputPath are required');
  const testCase = loadEasyCases(inputPath, caseIndex + 1)[caseIndex];
  if (!testCase) throw new Error('requested preflight case is unavailable');
  const runtimeContext = buildRuntimePlanningContext({ userRequest: testCase.description, schemaPath });
  const runtimeContextStats = planningContextStats(runtimeContext);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let report;
  try {
    if (dryRun) {
      report = {
        schemaVersion: '1.0', kind: 'runtime_aware_planner_preflight', executionPolicy: 'no_model_no_n8n_execution',
        caseId: testCase.caseId, model, maxTokens, reasoningEffort, startedAt, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs,
        outcome: 'planning_context_ready', runtimeContextStats,
      };
      atomicWrite(outputPath, report);
      return report;
    }
    const generated = await callPlanner({ messages: buildRuntimeAwarePlannerMessages({ userRequest: testCase.description, runtimeContext }), model, maxTokens, reasoningEffort, fetchImpl, env, timeoutMs });
    const { plan, acceptanceContract } = buildPlanFirstContract({ userRequest: testCase.description, rawPlan: generated.rawPlan, runtimeContext });
    report = {
      schemaVersion: '1.0', kind: 'runtime_aware_planner_preflight', executionPolicy: 'no_create_model_no_n8n_execution',
      caseId: testCase.caseId, model, maxTokens, reasoningEffort, startedAt, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs,
      outcome: acceptanceContract.configurationStatus === 'complete' ? 'plan_ready' : 'plan_requires_user_input_or_setup',
      httpStatus: generated.telemetry.httpStatus, contentType: generated.telemetry.contentType,
      runtimeContextStats,
      plan: safePlanSummary({ plan, acceptanceContract, runtimeContext }),
    };
  } catch (error) {
    report = {
      schemaVersion: '1.0', kind: 'runtime_aware_planner_preflight', executionPolicy: 'no_create_model_no_n8n_execution',
      caseId: testCase.caseId, model, maxTokens, reasoningEffort, startedAt, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs,
      outcome: 'planner_unavailable_or_contract_rejected',
      failureCategory: error?.kind || 'plan_contract_rejected',
      safeFailureCategory: error?.safeFailureCategory || error?.telemetry?.safeFailureCategory || null,
      httpStatus: Number.isInteger(error?.telemetry?.httpStatus) ? error.telemetry.httpStatus : null,
      contentType: error?.telemetry?.contentType || 'other_or_unavailable',
      runtimeContextStats,
    };
  }
  atomicWrite(outputPath, report);
  return report;
}

function main() {
  const caseIndex = Number.parseInt(process.env.PLAN_PREFLIGHT_CASE_INDEX || '0', 10);
  runPlannerPreflight({
    inputPath: process.env.PLAN_PREFLIGHT_INPUT_PATH,
    outputPath: process.env.PLAN_PREFLIGHT_OUTPUT_PATH,
    caseIndex: Number.isInteger(caseIndex) && caseIndex >= 0 ? caseIndex : 0,
    model: process.env.PLAN_PREFLIGHT_MODEL || DEFAULT_PLANNER_MODEL,
    maxTokens: Number.parseInt(process.env.PLAN_PREFLIGHT_MAX_TOKENS || String(DEFAULT_PLANNER_MAX_TOKENS), 10),
    reasoningEffort: process.env.PLAN_PREFLIGHT_REASONING_EFFORT || null,
    timeoutMs: Number.parseInt(process.env.PLAN_PREFLIGHT_TIMEOUT_MS || '120000', 10),
    dryRun: String(process.env.PLAN_PREFLIGHT_DRY_RUN || '').toLowerCase() === 'true',
  }).then((report) => process.stdout.write(JSON.stringify(report) + '\n'))
    .catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { DEFAULT_PLANNER_MAX_TOKENS, DEFAULT_PLANNER_MODEL, callPlanner, runPlannerPreflight, safePlanSummary };
