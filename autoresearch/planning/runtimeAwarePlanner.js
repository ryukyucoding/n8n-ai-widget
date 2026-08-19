'use strict';

const { normalizeAcceptanceContract } = require('../../chatbot/src/acceptanceContract');

const PLANNER_SYSTEM_PROMPT = [
  'You are a runtime-aware n8n workflow planner.',
  'Turn the user request into a plan for the installed n8n runtime.',
  'Return one JSON object only with: goal, trigger, data_sources, selected_nodes, output_contract, data_flow_requirements, assumptions, required_user_inputs, required_configuration, generator_instruction.',
  'selected_nodes must use only the supplied runtime candidate node types and exact typeVersion values.',
  'When explicitly named runtime nodes are required, selected_nodes must include them; when forbidden, selected_nodes must exclude them.',
  'Do not put credential values, API keys, URLs, or workflow JSON in the plan.',
  'When a credential or destination is required but absent, record it in required_configuration or required_user_inputs instead of inventing it.',
].join(' ');

function contractError(safeFailureCategory, message) {
  const error = new Error(message);
  error.safeFailureCategory = safeFailureCategory;
  return error;
}

function asObjects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function parsePlanJson(rawOutput) {
  if (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)) return rawOutput;
  if (typeof rawOutput !== 'string') return null;
  const candidates = [rawOutput.trim()];
  for (let start = rawOutput.indexOf('{'); start >= 0; start = rawOutput.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < rawOutput.length; index += 1) {
      const character = rawOutput[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        candidates.push(rawOutput.slice(start, index + 1));
        break;
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

function normalizeSelectedNodes(value, runtimeContext) {
  const allowed = new Map((runtimeContext?.candidateNodes || []).map((node) => [`${node.type}@${node.typeVersion}`, node]));
  const selected = asObjects(value).map((node) => ({ type: node.type, typeVersion: node.typeVersion }));
  if (!selected.length) throw contractError('selected_nodes_missing', 'planner selected_nodes is required');
  for (const node of selected) {
    if (typeof node.type !== 'string' || !Number.isFinite(Number(node.typeVersion)) || !allowed.has(`${node.type}@${Number(node.typeVersion)}`)) {
      throw contractError('selected_node_outside_runtime_catalog', 'planner selected a node outside the runtime candidate catalog');
    }
  }
  const selectedKeys = new Set(selected.map((node) => `${node.type}@${Number(node.typeVersion)}`));
  const requirements = runtimeContext?.explicitlyNamedNodeRequirements || { required: [], forbidden: [] };
  if ((requirements.required || []).some((node) => !selectedKeys.has(`${node.type}@${Number(node.typeVersion)}`))) {
    throw contractError('explicitly_required_node_missing', 'planner omitted an explicitly required runtime node');
  }
  if ((requirements.forbidden || []).some((node) => selectedKeys.has(`${node.type}@${Number(node.typeVersion)}`))) {
    throw contractError('explicitly_forbidden_node_selected', 'planner selected an explicitly forbidden runtime node');
  }
  return selected;
}

function requiredFields(value) {
  return asObjects(value).map((field) => ({
    path: typeof field.path === 'string' ? field.path : '',
    required: field.required === true,
    expected_type: typeof field.expected_type === 'string' ? field.expected_type : '',
  })).filter((field) => field.path && field.expected_type);
}

function normalizePlan(rawOutput, runtimeContext) {
  const plan = parsePlanJson(rawOutput);
  if (!plan) throw contractError('invalid_plan_json', 'planner returned invalid JSON');
  if (Array.isArray(plan.nodes) || plan.connections) throw contractError('workflow_json_instead_of_plan', 'planner returned workflow JSON instead of a plan');
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) throw contractError('goal_missing', 'planner goal is required');
  if (typeof plan.generator_instruction !== 'string' || !plan.generator_instruction.trim()) throw contractError('generator_instruction_missing', 'planner generator_instruction is required');
  const selectedNodes = normalizeSelectedNodes(plan.selected_nodes, runtimeContext);
  const outputContract = plan.output_contract && typeof plan.output_contract === 'object' && !Array.isArray(plan.output_contract)
    ? {
      required: plan.output_contract.required === true,
      delivery_shape: typeof plan.output_contract.delivery_shape === 'string' ? plan.output_contract.delivery_shape : '',
      item_count: Number.isInteger(plan.output_contract.item_count) ? plan.output_contract.item_count : null,
      fields: requiredFields(plan.output_contract.fields),
    }
    : null;
  return {
    goal: plan.goal.trim(),
    trigger: typeof plan.trigger === 'string' ? plan.trigger.trim() : '',
    data_sources: asObjects(plan.data_sources),
    selected_nodes: selectedNodes,
    output_contract_required: outputContract?.required === true,
    output_contract: outputContract || [],
    data_flow_requirements: Array.isArray(plan.data_flow_requirements) ? plan.data_flow_requirements.filter((item) => typeof item === 'string') : [],
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.filter((item) => typeof item === 'string') : [],
    required_user_inputs: asObjects(plan.required_user_inputs),
    required_configuration: asObjects(plan.required_configuration),
    generator_instruction: plan.generator_instruction.trim(),
  };
}

function buildRuntimeAwarePlannerMessages({ userRequest, runtimeContext }) {
  if (typeof userRequest !== 'string' || !userRequest.trim()) throw new TypeError('userRequest must be a non-empty string');
  if (!runtimeContext?.candidateNodes?.length) throw new Error('runtime candidate catalog is empty');
  return [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: userRequest.trim() },
    { role: 'user', content: JSON.stringify(runtimeContext) },
  ];
}

function buildPlanFirstContract({ userRequest, rawPlan, runtimeContext }) {
  const plan = normalizePlan(rawPlan, runtimeContext);
  const acceptanceContract = normalizeAcceptanceContract({ userRequest, plannerResult: plan, deliveryMode: 'candidate-only' });
  return { plan, acceptanceContract };
}

module.exports = {
  PLANNER_SYSTEM_PROMPT,
  buildPlanFirstContract,
  buildRuntimeAwarePlannerMessages,
  contractError,
  normalizePlan,
  normalizeSelectedNodes,
  parsePlanJson,
};
