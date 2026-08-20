'use strict';

const { safeContentType } = require('../../chatbot/tests/modelBenchmark/createJsonPolicy');
const { safeHttpFailureCategory } = require('../experiments/easy100/runEasy100Batch');
const { buildPlanFirstContract } = require('./runtimeAwarePlanner');

const MAX_TOOL_ROUNDS = 4;
const PLANNER_TOOLS = [
  { type: 'function', function: { name: 'get_runtime_catalog', description: 'Read installed runtime node cards and explicit node requirements for this task.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'submit_plan', description: 'Submit a plan using previously read runtime cards. The plan is checked immediately.', parameters: { type: 'object', properties: { goal: { type: 'string' }, selected_nodes: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, typeVersion: { type: 'number' } }, required: ['type', 'typeVersion'], additionalProperties: false }, minItems: 1, maxItems: 12 }, generator_instruction: { type: 'string' }, required_user_inputs: { type: 'array', items: { type: 'string' }, maxItems: 12 }, required_configuration: { type: 'array', items: { type: 'string' }, maxItems: 12 } }, required: ['goal', 'selected_nodes', 'generator_instruction', 'required_user_inputs', 'required_configuration'], additionalProperties: false } } },
];
const SYSTEM_PROMPT = 'You are a constrained n8n workflow planner. Use tools only. First call get_runtime_catalog, then submit_plan. Do not output prose, workflow JSON, credential values, URLs, or shell commands. If submission returns a contract error, correct it with the next tool call.';

function parseArguments(call) { try { return JSON.parse(call?.function?.arguments || '{}'); } catch { return null; } }
function planFromArguments(args) {
  return { goal: args.goal, selected_nodes: args.selected_nodes, generator_instruction: args.generator_instruction,
    required_user_inputs: args.required_user_inputs.map((label) => ({ label })), required_configuration: args.required_configuration.map((label) => ({ label })),
    trigger: '', data_sources: [], data_flow_requirements: [], assumptions: [], output_contract: { required: false } };
}

async function callModel({ messages, model, maxTokens, reasoningEffort, timeoutMs, fetchImpl, env }) {
  const baseUrl = String(env?.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) throw { kind: 'route_unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
    const body = { model, temperature: 0, max_tokens: maxTokens, messages, tools: PLANNER_TOOLS, tool_choice: 'auto' };
    if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) body.reasoning_effort = reasoningEffort.trim();
    const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
    const telemetry = { httpStatus: Number.isInteger(response?.status) ? response.status : null, contentType: safeContentType(response?.headers?.get?.('content-type')) };
    if (!response.ok) { let text = null; try { text = await response.text(); } catch {} throw { kind: 'http_failure', telemetry: { ...telemetry, safeFailureCategory: safeHttpFailureCategory(text) } }; }
    const payload = await response.json();
    return { message: payload?.choices?.[0]?.message || {}, telemetry };
  } catch (error) { if (error?.name === 'AbortError') throw { kind: 'timeout' }; throw error?.kind ? error : { kind: 'transport' }; } finally { clearTimeout(timer); }
}

async function callToolPlanner({ userRequest, runtimeContext, model, maxTokens = 700, reasoningEffort = 'none', timeoutMs = 60000, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userRequest }];
  let catalogRead = false;
  let accepted = null;
  let telemetry = { httpStatus: null, contentType: 'other_or_unavailable' };
  const toolCalls = [];
  const toolResults = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS && !accepted; round += 1) {
    const generated = await callModel({ messages, model, maxTokens, reasoningEffort, timeoutMs, fetchImpl, env });
    telemetry = generated.telemetry;
    const calls = Array.isArray(generated.message?.tool_calls) ? generated.message.tool_calls : [];
    if (!calls.length) break;
    messages.push({ role: 'assistant', content: generated.message.content || '', tool_calls: calls });
    for (const call of calls) {
      const name = call?.function?.name;
      const args = parseArguments(call);
      toolCalls.push(typeof name === 'string' ? name : 'invalid_tool');
      let result;
      if (!args || !PLANNER_TOOLS.some((tool) => tool.function.name === name)) result = { ok: false, error: 'invalid_tool_call' };
      else if (name === 'get_runtime_catalog') { catalogRead = true; result = { ok: true, runtimeContext }; }
      else if (!catalogRead) result = { ok: false, error: 'runtime_catalog_not_read' };
      else {
        try { accepted = buildPlanFirstContract({ userRequest, rawPlan: planFromArguments(args), runtimeContext }); result = { ok: true, selectedNodeCount: accepted.plan.selected_nodes.length, configurationStatus: accepted.acceptanceContract.configurationStatus }; }
        catch (error) { result = { ok: false, error: error?.safeFailureCategory || 'plan_contract_rejected' }; }
      }
      toolResults.push({ name: typeof name === 'string' ? name : 'invalid_tool', ok: result.ok === true, error: result.ok === true ? null : result.error || 'tool_call_rejected' });
      messages.push({ role: 'tool', tool_call_id: call.id || `round-${round}`, content: JSON.stringify(result) });
    }
  }
  if (!accepted) {
    const error = new Error('tool planner did not submit an accepted plan');
    error.kind = 'plan_contract_rejected';
    error.safeFailureCategory = 'tool_plan_not_accepted';
    error.toolCalls = toolCalls;
    error.toolResults = toolResults;
    throw error;
  }
  return { ...accepted, telemetry, toolCalls, toolResults };
}

module.exports = { MAX_TOOL_ROUNDS, PLANNER_TOOLS, SYSTEM_PROMPT, callToolPlanner, planFromArguments };
