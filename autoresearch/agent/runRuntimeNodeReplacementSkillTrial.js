'use strict';

// Bounded semantic-node-replacement trial. The model chooses from a planner
// supplied, capability-labelled runtime allowlist. No n8n API is available.

const fs = require('node:fs');
const path = require('node:path');
const { safeContentType, availabilityFailure } = require('../../chatbot/tests/modelBenchmark/createJsonPolicy');
const { toProvisionWorkflow } = require('../../chatbot/tests/createFixtures/c01FixtureIntegrity');
const { findingCategoryCounts, safeHttpFailureCategory, verifyStatic } = require('../experiments/easy100/runEasy100Batch');
const { loadRuntimeNodeTypes } = require('../planning/runtimeSchemaCatalog');

const DEFAULT_MODEL = 'qwen3.8:27b';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TOOL_ROUNDS = 4;
const REQUIRED_CAPABILITY = 'http_get';

const TOOLS = [
  { type: 'function', function: { name: 'get_validation', description: 'Validate the loaded workflow and report whether a replacement is required.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'get_replacement_options', description: 'Read planner-approved installed runtime replacement cards for one node.', parameters: { type: 'object', properties: { nodeIndex: { type: 'integer' } }, required: ['nodeIndex'], additionalProperties: false } } },
  { type: 'function', function: { name: 'replace_node_with_card', description: 'Replace one invalid node only with a planner-approved card that has the required capability.', parameters: { type: 'object', properties: { nodeIndex: { type: 'integer' }, type: { type: 'string' }, typeVersion: { type: 'number' } }, required: ['nodeIndex', 'type', 'typeVersion'], additionalProperties: false } } },
];

const SYSTEM = [
  'You are a constrained n8n runtime repair agent.',
  'Use tools only. Do not output workflow JSON, prose, credentials, URLs, or shell commands.',
  'Call get_validation first. If replacement is required, inspect get_replacement_options before replacing.',
  'Choose only a card whose capability exactly matches the required capability, then validate again.',
].join(' ');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function latestVersion(nodeTypes, type) {
  return Object.keys(nodeTypes?.[type]?.versions || {}).map(Number).filter(Number.isFinite).sort((left, right) => right - left)[0] || null;
}

function buildFixture() {
  const workflow = clone(toProvisionWorkflow());
  const nodeIndex = workflow.nodes.findIndex((node) => node.type === 'n8n-nodes-base.httpRequest');
  if (nodeIndex < 0) throw new Error('replacement fixture http request node unavailable');
  workflow.nodes[nodeIndex].type = 'n8n-nodes-base.unavailableHttp';
  workflow.nodes[nodeIndex].typeVersion = 1;
  return { workflow, nodeIndex };
}

function approvedReplacementCards(nodeTypes) {
  const cards = [
    { type: 'n8n-nodes-base.manualTrigger', capability: 'trigger' },
    { type: 'n8n-nodes-base.httpRequest', capability: 'http_get' },
    { type: 'n8n-nodes-base.set', capability: 'transform' },
  ].map((card) => ({ ...card, typeVersion: latestVersion(nodeTypes, card.type) }))
    .filter((card) => card.typeVersion !== null);
  if (!cards.some((card) => card.capability === REQUIRED_CAPABILITY)) throw new Error('required runtime replacement card unavailable');
  return cards;
}

async function validate(workflow, verify) {
  try {
    const result = await verify(workflow, 'Controlled HTTP GET node replacement fixture.');
    return { status: result.status, findingCategories: findingCategoryCounts(result) };
  } catch (error) {
    return { status: 'repair', findingCategories: findingCategoryCounts({ findings: Array.isArray(error?.findings) ? error.findings : [] }) };
  }
}

function parseArguments(call) {
  try { return JSON.parse(call?.function?.arguments || '{}'); } catch { return null; }
}

function createSkill({ workflow, targetNodeIndex, cards, verify }) {
  const inspected = new Set();
  const toolCalls = [];
  const replacements = [];
  async function execute(call) {
    const name = call?.function?.name;
    const args = parseArguments(call);
    toolCalls.push(typeof name === 'string' ? name : 'invalid_tool');
    if (!args || !TOOLS.some((tool) => tool.function.name === name)) return { ok: false, error: 'invalid_tool_call' };
    if (name === 'get_validation') {
      const result = await validate(workflow, verify);
      const replacementRequired = workflow.nodes[targetNodeIndex]?.type !== 'n8n-nodes-base.httpRequest';
      return { ok: true, validation: result, replacementRequired, requiredCapability: replacementRequired ? REQUIRED_CAPABILITY : null, nodeIndex: replacementRequired ? targetNodeIndex : null };
    }
    if (name === 'get_replacement_options') {
      if (!Number.isInteger(args.nodeIndex) || args.nodeIndex !== targetNodeIndex) return { ok: false, error: 'invalid_node_index' };
      inspected.add(args.nodeIndex);
      return { ok: true, nodeIndex: args.nodeIndex, requiredCapability: REQUIRED_CAPABILITY, cards };
    }
    if (!Number.isInteger(args.nodeIndex) || args.nodeIndex !== targetNodeIndex || !inspected.has(args.nodeIndex)) return { ok: false, error: 'runtime_card_not_inspected' };
    const selected = cards.find((card) => card.type === args.type && card.typeVersion === Number(args.typeVersion));
    if (!selected || selected.capability !== REQUIRED_CAPABILITY) return { ok: false, error: 'replacement_not_authorized' };
    workflow.nodes[targetNodeIndex].type = selected.type;
    workflow.nodes[targetNodeIndex].typeVersion = selected.typeVersion;
    replacements.push({ requested: 1, applied: 1, capabilityMatched: true });
    return { ok: true, applied: 1 };
  }
  return { execute, toolCalls, replacements };
}

async function callModel({ messages, model, reasoningEffort, timeoutMs, fetchImpl, env }) {
  const baseUrl = String(env?.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const body = { model, temperature: 0, max_tokens: 1024, messages, tools: TOOLS, tool_choice: 'auto' };
    if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) body.reasoning_effort = reasoningEffort.trim();
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
    const telemetry = { httpStatus: Number.isInteger(response?.status) ? response.status : null, contentType: safeContentType(response?.headers?.get?.('content-type')) };
    if (!response.ok) {
      let text = null;
      try { text = await response.text(); } catch {}
      throw { kind: 'http_failure', telemetry: { ...telemetry, safeFailureCategory: safeHttpFailureCategory(text) } };
    }
    const payload = await response.json();
    return payload?.choices?.[0]?.message || {};
  } catch (error) {
    if (error?.name === 'AbortError') throw { kind: 'timeout' };
    throw error?.kind ? error : { kind: 'transport' };
  } finally { clearTimeout(timer); }
}

async function runRuntimeNodeReplacementSkillTrial({ outputPath, model = DEFAULT_MODEL, reasoningEffort = 'none', timeoutMs = DEFAULT_TIMEOUT_MS, maxToolRounds = MAX_TOOL_ROUNDS, fetchImpl = globalThis.fetch, env = process.env, verify = verifyStatic, nodeTypes } = {}) {
  if (!outputPath) throw new TypeError('outputPath is required');
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const resolvedNodeTypes = nodeTypes || loadRuntimeNodeTypes();
  const { workflow, nodeIndex } = buildFixture();
  const skill = createSkill({ workflow, targetNodeIndex: nodeIndex, cards: approvedReplacementCards(resolvedNodeTypes), verify });
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Repair the loaded workflow fixture using the available tools.' }];
  let failure = null;
  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      const message = await callModel({ messages, model, reasoningEffort, timeoutMs, fetchImpl, env });
      const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      if (!calls.length) break;
      messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls });
      for (const call of calls) messages.push({ role: 'tool', tool_call_id: call.id || `round-${round}`, content: JSON.stringify(await skill.execute(call)) });
    }
  } catch (error) {
    failure = { failureCategory: availabilityFailure(error), safeFailureCategory: error?.telemetry?.safeFailureCategory || null, httpStatus: error?.telemetry?.httpStatus || null };
  }
  const finalValidation = await validate(workflow, verify);
  const report = {
    schemaVersion: '1.0', kind: 'runtime_node_replacement_skill_trial', executionPolicy: 'no_n8n_create_or_execution',
    model, reasoningEffort, startedAt, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedMs,
    outcome: failure ? 'agent_unavailable' : (finalValidation.status === 'pass' || finalValidation.status === 'warning' ? 'static_pass' : 'static_blocked'),
    toolCallCount: skill.toolCalls.length, toolCalls: skill.toolCalls, replacements: skill.replacements, finalValidation, ...failure,
  };
  atomicWrite(outputPath, report);
  return report;
}

if (require.main === module) runRuntimeNodeReplacementSkillTrial({ outputPath: process.env.RUNTIME_REPLACEMENT_SKILL_OUTPUT_PATH }).then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { TOOLS, approvedReplacementCards, buildFixture, createSkill, runRuntimeNodeReplacementSkillTrial };
