'use strict';

// A single bounded integration check. It keeps the plan and generated
// workflow in memory, then reports only safe aggregate statuses. It never
// creates or executes an n8n workflow.

const fs = require('node:fs');
const path = require('node:path');
const { parseJsonCandidate, availabilityFailure } = require('../../chatbot/tests/modelBenchmark/createJsonPolicy');
const {
  createRequest, findingCategoryCounts, loadEasyCases, readinessFrom,
  safeCapabilitySummary, verifyStatic,
} = require('../experiments/easy100/runEasy100Batch');
const { buildRuntimePlanningContext, planningContextStats } = require('./runtimeSchemaCatalog');
const { buildPlanFirstContract, buildRuntimeAwarePlannerMessages } = require('./runtimeAwarePlanner');
const { callPlanner, DEFAULT_PLANNER_MAX_TOKENS, DEFAULT_PLANNER_MODEL } = require('./runPlannerPreflight');
const { callToolPlanner } = require('./runToolPlanner');

const DEFAULT_CREATE_MODEL = 'qwen2.5-coder-32b-ft-original:latest';

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function selectedRuntimeCards(plan, runtimeContext) {
  const selected = new Set(plan.selected_nodes.map((node) => `${node.type}@${node.typeVersion}`));
  return runtimeContext.candidateNodes.filter((node) => selected.has(`${node.type}@${node.typeVersion}`));
}

function planInstruction(plan, runtimeContext) {
  const cards = selectedRuntimeCards(plan, runtimeContext);
  return [
    'Runtime-aware planning instruction:',
    plan.generator_instruction,
    'The following installed node cards are the complete allowed node set for this workflow:',
    JSON.stringify(cards),
    'Use every node type with its exact listed typeVersion. Do not substitute, invent, or add any other node type.',
    'Return one n8n workflow JSON object only. Do not include credentials, secrets, or prose.',
  ].join('\n');
}

async function callCreateModel({ fetchImpl = globalThis.fetch, env = process.env, model, description, systemPrompt, plan, runtimeContext, timeoutMs = 180000 }) {
  const baseUrl = String(env.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = createRequest({ model, description, systemPrompt, jsonMode: false });
    request.messages.push({ role: 'user', content: planInstruction(plan, runtimeContext) });
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
      method: 'POST', headers, signal: controller.signal, body: JSON.stringify(request),
    });
    if (!response.ok) {
      let body = null;
      try { body = await response.text(); } catch {}
      throw { kind: 'http_failure', telemetry: { httpStatus: response.status, safeFailureCategory: require('../experiments/easy100/runEasy100Batch').safeHttpFailureCategory(body) } };
    }
    const payload = await response.json();
    return { rawOutput: payload?.choices?.[0]?.message?.content ?? '', telemetry: { httpStatus: response.status } };
  } catch (error) {
    if (error?.name === 'AbortError') throw { kind: 'timeout' };
    throw error?.kind ? error : { kind: 'transport' };
  } finally {
    clearTimeout(timer);
  }
}

function safePlanSummary(plan, acceptanceContract, runtimeContext) {
  return {
    selectedNodeCount: plan.selected_nodes.length,
    allSelectedNodesInRuntimeCatalog: plan.selected_nodes.every((node) => runtimeContext.candidateNodes.some((candidate) => candidate.type === node.type && candidate.typeVersion === node.typeVersion)),
    requiredUserInputCount: plan.required_user_inputs.length,
    requiredConfigurationCount: plan.required_configuration.length,
    configurationStatus: acceptanceContract.configurationStatus,
  };
}

function safePlanCompliance(workflow, plan) {
  const allowed = new Set(plan.selected_nodes.map((node) => `${node.type}@${node.typeVersion}`));
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const generated = new Set(nodes.map((node) => `${node?.type}@${node?.typeVersion}`));
  return {
    generatedNodeCount: nodes.length,
    nodesOutsideSelectedPlanCount: nodes.filter((node) => !allowed.has(`${node?.type}@${node?.typeVersion}`)).length,
    missingSelectedNodeTypeCount: [...allowed].filter((key) => !generated.has(key)).length,
  };
}

function safePreflightFailureCategory(error) {
  return error?.kind === 'plan_contract_rejected' ? 'plan_contract_rejected' : availabilityFailure(error);
}

async function runPlanFirstCreatePreflight({ inputPath, outputPath, caseIndex = 0, plannerModel = DEFAULT_PLANNER_MODEL, plannerMode = 'json', createModel = DEFAULT_CREATE_MODEL, plannerMaxTokens = DEFAULT_PLANNER_MAX_TOKENS, plannerReasoningEffort = 'none', plannerTimeoutMs = 60000, createTimeoutMs = 180000, schemaPath, fetchImpl, env, verify = verifyStatic } = {}) {
  if (!inputPath || !outputPath) throw new TypeError('inputPath and outputPath are required');
  const testCase = loadEasyCases(inputPath, caseIndex + 1)[caseIndex];
  if (!testCase) throw new Error('requested preflight case is unavailable');
  const runtimeContext = buildRuntimePlanningContext({ userRequest: testCase.description, schemaPath });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const base = {
    schemaVersion: '1.0', kind: 'plan_first_create_preflight', executionPolicy: 'no_n8n_create_or_execution',
    caseId: testCase.caseId, plannerModel, plannerMode, createModel, startedAt, runtimeContextStats: planningContextStats(runtimeContext),
  };
  let report;
  try {
    const useToolPlanner = plannerMode === 'tool';
    const plannerResponse = useToolPlanner
      ? await callToolPlanner({ userRequest: testCase.description, runtimeContext, model: plannerModel, maxTokens: plannerMaxTokens, reasoningEffort: plannerReasoningEffort, fetchImpl, env, timeoutMs: plannerTimeoutMs })
      : await callPlanner({
        messages: buildRuntimeAwarePlannerMessages({ userRequest: testCase.description, runtimeContext }),
        model: plannerModel, maxTokens: plannerMaxTokens, reasoningEffort: plannerReasoningEffort, fetchImpl, env, timeoutMs: plannerTimeoutMs,
      });
    const { plan, acceptanceContract } = useToolPlanner
      ? plannerResponse
      : buildPlanFirstContract({ userRequest: testCase.description, rawPlan: plannerResponse.rawPlan, runtimeContext });
    const created = await callCreateModel({ fetchImpl, env, model: createModel, description: testCase.description, systemPrompt: testCase.systemPrompt, plan, runtimeContext, timeoutMs: createTimeoutMs });
    const parsed = parseJsonCandidate(created.rawOutput);
    let verification = null;
    let capability = { usesCredentials: false, writesExternally: false, hasCode: false };
    const planCompliance = parsed.ok ? safePlanCompliance(parsed.value, plan) : null;
    if (parsed.ok) {
      verification = await verify(parsed.value, testCase.description);
      capability = safeCapabilitySummary(parsed.value);
    }
    report = {
      ...base, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs, outcome: 'completed',
      planner: {
        ...safePlanSummary(plan, acceptanceContract, runtimeContext),
        mode: plannerMode,
        toolCallCount: Array.isArray(plannerResponse.toolCalls) ? plannerResponse.toolCalls.length : 0,
      },
      create: {
        httpStatus: created.telemetry.httpStatus, strictJsonStatus: parsed.strictJsonStatus,
        repairedJsonStatus: parsed.repairedJsonStatus,
        staticStatus: planCompliance?.missingSelectedNodeTypeCount ? 'plan_incomplete' : (verification?.status || 'not_run'),
        findingCategories: findingCategoryCounts(verification),
        planCompliance,
        executionReadiness: readinessFrom({ parsed, verification, capability }).category,
      },
    };
  } catch (error) {
    report = {
      ...base, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs,
      outcome: 'planner_or_create_unavailable_or_rejected', failureCategory: safePreflightFailureCategory(error),
      safeFailureCategory: error?.safeFailureCategory || error?.telemetry?.safeFailureCategory || null,
      httpStatus: Number.isInteger(error?.telemetry?.httpStatus) ? error.telemetry.httpStatus : null,
    };
  }
  atomicWrite(outputPath, report);
  return report;
}

function main() {
  runPlanFirstCreatePreflight({
    inputPath: process.env.PLAN_FIRST_INPUT_PATH, outputPath: process.env.PLAN_FIRST_OUTPUT_PATH,
    caseIndex: Number.parseInt(process.env.PLAN_FIRST_CASE_INDEX || '0', 10) || 0,
    plannerModel: process.env.PLAN_FIRST_PLANNER_MODEL || DEFAULT_PLANNER_MODEL,
    plannerMode: process.env.PLAN_FIRST_PLANNER_MODE || 'json',
    createModel: process.env.PLAN_FIRST_CREATE_MODEL || DEFAULT_CREATE_MODEL,
    plannerMaxTokens: Number.parseInt(process.env.PLAN_FIRST_PLANNER_MAX_TOKENS || String(DEFAULT_PLANNER_MAX_TOKENS), 10),
    plannerReasoningEffort: process.env.PLAN_FIRST_PLANNER_REASONING_EFFORT || 'none',
    plannerTimeoutMs: Number.parseInt(process.env.PLAN_FIRST_PLANNER_TIMEOUT_MS || '60000', 10),
    createTimeoutMs: Number.parseInt(process.env.PLAN_FIRST_CREATE_TIMEOUT_MS || '180000', 10),
  }).then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { DEFAULT_CREATE_MODEL, callCreateModel, planInstruction, runPlanFirstCreatePreflight, safePlanCompliance, safePlanSummary, safePreflightFailureCategory, selectedRuntimeCards };
