'use strict';

// A bounded tool-use trial. The model can inspect runtime cards, request a
// static validation, apply allowlisted local patches, and validate again. It
// cannot access credentials, the filesystem, n8n, or arbitrary commands.

const fs = require('node:fs');
const path = require('node:path');
const { safeContentType, availabilityFailure } = require('../../chatbot/tests/modelBenchmark/createJsonPolicy');
const { toProvisionWorkflow } = require('../../chatbot/tests/createFixtures/c01FixtureIntegrity');
const { findingCategoryCounts, safeHttpFailureCategory, verifyStatic } = require('../experiments/easy100/runEasy100Batch');
const { loadRuntimeNodeTypes } = require('../planning/runtimeSchemaCatalog');

const DEFAULT_MODEL = 'qwen3.8:27b';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TOOL_ROUNDS = 4;

const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'get_validation', description: 'Validate the loaded workflow and return safe repair issues.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'get_runtime_card', description: 'Read the installed n8n runtime card for one workflow node index.', parameters: { type: 'object', properties: { nodeIndex: { type: 'integer' } }, required: ['nodeIndex'], additionalProperties: false } } },
  { type: 'function', function: { name: 'apply_runtime_patch', description: 'Apply only allowed type-version or invalid-parameter-removal edits after inspecting that node runtime card.', parameters: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['set_type_version', 'remove_parameter'] }, nodeIndex: { type: 'integer' }, typeVersion: { type: 'number' }, parameterName: { type: 'string' } }, required: ['kind', 'nodeIndex'], additionalProperties: false }, maxItems: 4 } }, required: ['operations'], additionalProperties: false } } },
];

const SYSTEM_PROMPT = [
  'You are a constrained n8n runtime repair agent.',
  'A workflow fixture is loaded only inside the repair skill.',
  'You must first call get_validation, then inspect a runtime card for every node you patch.',
  'Use apply_runtime_patch only for allowed local edits, then call get_validation again.',
  'Do not write prose, credentials, URLs, shell commands, or a workflow JSON.',
  'Stop after validation passes or the tool budget is exhausted.',
].join(' ');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function buildFixture() {
  const workflow = clone(toProvisionWorkflow());
  const nodeIndex = workflow.nodes.findIndex((node) => node.type === 'n8n-nodes-base.httpRequest');
  if (nodeIndex < 0) throw new Error('repair fixture http request node unavailable');
  workflow.nodes[nodeIndex].typeVersion = 999;
  workflow.nodes[nodeIndex].parameters.__runtimeRepairProbe__ = true;
  return workflow;
}

function runtimeCard(node, nodeTypes) {
  const entry = nodeTypes?.[node?.type];
  const versionKeys = Object.keys(entry?.versions || {}).filter((version) => Number.isFinite(Number(version)));
  const versions = versionKeys.map(Number).sort((left, right) => right - left);
  const preferred = versionKeys.sort((left, right) => Number(right) - Number(left))[0];
  const definition = preferred ? entry.versions[preferred] : null;
  const parameterNames = [...new Set((definition?.properties || []).map((property) => property?.name).filter((name) => typeof name === 'string'))].sort();
  return { nodeType: typeof node?.type === 'string' ? node.type : null, allowedTypeVersions: versions, allowedParameterNames: parameterNames };
}

function repairIssues(workflow, nodeTypes) {
  const issues = [];
  for (const [nodeIndex, node] of (workflow?.nodes || []).entries()) {
    const card = runtimeCard(node, nodeTypes);
    if (!card.nodeType || !nodeTypes?.[card.nodeType]) {
      issues.push({ kind: 'unsupported_node_type', nodeIndex });
      continue;
    }
    if (!card.allowedTypeVersions.includes(Number(node.typeVersion))) issues.push({ kind: 'type_version', nodeIndex });
    const valid = new Set(card.allowedParameterNames);
    for (const parameterName of Object.keys(node.parameters || {}).sort()) {
      if (!valid.has(parameterName)) issues.push({ kind: 'parameter_schema', nodeIndex, parameterName });
    }
  }
  return issues;
}

async function staticValidation(workflow, userRequest, verify) {
  try {
    const verification = await verify(workflow, userRequest);
    return { status: verification.status, findingCategories: findingCategoryCounts(verification) };
  } catch (error) {
    const verification = { findings: Array.isArray(error?.findings) ? error.findings : [] };
    return { status: 'repair', findingCategories: findingCategoryCounts(verification) };
  }
}

function parseArguments(call) {
  try { return JSON.parse(call?.function?.arguments || '{}'); } catch { return null; }
}

function createSkill({ workflow, userRequest, nodeTypes, verify }) {
  const inspected = new Set();
  const toolCalls = [];
  const actionLog = [];
  async function execute(call) {
    const name = call?.function?.name;
    const args = parseArguments(call);
    toolCalls.push(typeof name === 'string' ? name : 'invalid_tool');
    if (!args || !TOOL_DEFINITIONS.some((tool) => tool.function.name === name)) return { ok: false, error: 'invalid_tool_call' };
    if (name === 'get_validation') {
      const validation = await staticValidation(workflow, userRequest, verify);
      return { ok: true, validation, issues: repairIssues(workflow, nodeTypes) };
    }
    if (name === 'get_runtime_card') {
      const nodeIndex = args.nodeIndex;
      if (!Number.isInteger(nodeIndex) || !workflow.nodes[nodeIndex]) return { ok: false, error: 'invalid_node_index' };
      inspected.add(nodeIndex);
      return { ok: true, nodeIndex, runtimeCard: runtimeCard(workflow.nodes[nodeIndex], nodeTypes) };
    }
    const operations = Array.isArray(args.operations) ? args.operations : [];
    if (!operations.length || operations.length > 4) return { ok: false, error: 'invalid_patch_operations' };
    const issues = repairIssues(workflow, nodeTypes);
    let applied = 0;
    for (const operation of operations) {
      const node = workflow.nodes[operation?.nodeIndex];
      if (!node || !inspected.has(operation.nodeIndex)) continue;
      const card = runtimeCard(node, nodeTypes);
      if (operation.kind === 'set_type_version'
        && card.allowedTypeVersions.includes(Number(operation.typeVersion))
        && issues.some((issue) => issue.kind === 'type_version' && issue.nodeIndex === operation.nodeIndex)) {
        node.typeVersion = Number(operation.typeVersion);
        applied += 1;
      }
      if (operation.kind === 'remove_parameter'
        && typeof operation.parameterName === 'string'
        && issues.some((issue) => issue.kind === 'parameter_schema' && issue.nodeIndex === operation.nodeIndex && issue.parameterName === operation.parameterName)) {
        delete node.parameters[operation.parameterName];
        applied += 1;
      }
    }
    actionLog.push({ requested: operations.length, applied });
    return { ok: applied > 0, applied };
  }
  return { execute, toolCalls, actionLog };
}

async function callModel({ messages, model, reasoningEffort, timeoutMs, fetchImpl, env }) {
  const baseUrl = String(env?.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const body = { model, temperature: 0, max_tokens: 1024, messages, tools: TOOL_DEFINITIONS, tool_choice: 'auto' };
    if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) body.reasoning_effort = reasoningEffort.trim();
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
    const telemetry = { httpStatus: Number.isInteger(response?.status) ? response.status : null, contentType: safeContentType(response?.headers?.get?.('content-type')) };
    if (!response.ok) {
      let text = null;
      try { text = await response.text(); } catch {}
      throw { kind: 'http_failure', telemetry: { ...telemetry, safeFailureCategory: safeHttpFailureCategory(text) } };
    }
    const payload = await response.json();
    return { message: payload?.choices?.[0]?.message || {}, telemetry };
  } catch (error) {
    if (error?.name === 'AbortError') throw { kind: 'timeout' };
    throw error?.kind ? error : { kind: 'transport' };
  } finally { clearTimeout(timer); }
}

async function runRuntimeRepairSkillTrial({ outputPath, workflow, userRequest = 'Controlled runtime repair fixture.', model = DEFAULT_MODEL, reasoningEffort = 'none', timeoutMs = DEFAULT_TIMEOUT_MS, maxToolRounds = MAX_TOOL_ROUNDS, fetchImpl = globalThis.fetch, env = process.env, verify = verifyStatic, nodeTypes } = {}) {
  if (!outputPath) throw new TypeError('outputPath is required');
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const loadedWorkflow = workflow ? clone(workflow) : buildFixture();
  const skill = createSkill({ workflow: loadedWorkflow, userRequest, nodeTypes: nodeTypes || loadRuntimeNodeTypes(), verify });
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'Repair the loaded workflow fixture using the available tools.' }];
  let failure = null;
  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      const generated = await callModel({ messages, model, reasoningEffort, timeoutMs, fetchImpl, env });
      const calls = Array.isArray(generated.message?.tool_calls) ? generated.message.tool_calls : [];
      if (!calls.length) break;
      messages.push({ role: 'assistant', content: generated.message.content || '', tool_calls: calls });
      for (const call of calls) {
        const result = await skill.execute(call);
        messages.push({ role: 'tool', tool_call_id: call.id || `round-${round}`, content: JSON.stringify(result) });
      }
    }
  } catch (error) {
    failure = { failureCategory: availabilityFailure(error), safeFailureCategory: error?.telemetry?.safeFailureCategory || null, httpStatus: error?.telemetry?.httpStatus || null };
  }
  const finalValidation = await staticValidation(loadedWorkflow, userRequest, verify);
  const report = {
    schemaVersion: '1.0', kind: 'runtime_repair_skill_trial', executionPolicy: 'no_n8n_create_or_execution',
    model, reasoningEffort, startedAt, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs,
    outcome: failure ? 'agent_unavailable' : (finalValidation.status === 'pass' || finalValidation.status === 'warning' ? 'static_pass' : 'static_blocked'),
    toolCallCount: skill.toolCalls.length,
    toolCalls: skill.toolCalls,
    patchActions: skill.actionLog,
    finalValidation,
    ...failure,
  };
  atomicWrite(outputPath, report);
  return report;
}

if (require.main === module) {
  runRuntimeRepairSkillTrial({ outputPath: process.env.RUNTIME_REPAIR_SKILL_OUTPUT_PATH, maxToolRounds: Number.parseInt(process.env.RUNTIME_REPAIR_SKILL_MAX_TOOL_ROUNDS || String(MAX_TOOL_ROUNDS), 10) }).then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

module.exports = { TOOL_DEFINITIONS, buildFixture, createSkill, runRuntimeRepairSkillTrial };
