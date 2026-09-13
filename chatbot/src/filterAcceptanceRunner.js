'use strict';

// Future operator-only Filter v2.3 fixture runner. The condition AST is
// intentionally injected from n8n readback; this module never guesses it and
// never touches an existing workflow. It is not wired into the main batch.

const FILTER_FIXTURE_ID = 'filter_boolean_equals';
const FILTER_NODE_TYPE = 'n8n-nodes-base.filter';
const FILTER_TYPE_VERSION = 2.3;
const SECRET_KEYS = new Set(['credential', 'credentials', 'token', 'secret', 'password', 'authorization', 'apikey', 'api_key']);
const SECRET_VALUE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|\bbearer\s+[A-Za-z0-9._-]{8,}\b|\b(?:sk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{8,}\b/i;

function assert(condition, message) { if (!condition) throw new Error(message); }
function validId(value) { return (typeof value === 'string' || typeof value === 'number') && /^[A-Za-z0-9_-]{1,128}$/.test(String(value)); }
function safeTree(value, path = 'conditionAst') {
  if (typeof value === 'string') {
    assert(value.length <= 512 && !SECRET_VALUE.test(value), `${path} contains unsafe value`);
  } else if (Array.isArray(value)) value.forEach((item, i) => safeTree(item, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!SECRET_KEYS.has(key.toLowerCase()), `${path} contains forbidden key ${key}`);
      safeTree(child, `${path}.${key}`);
    }
  }
}

function buildFilterFixture(conditionAst) {
  assert(conditionAst && typeof conditionAst === 'object' && !Array.isArray(conditionAst), 'condition AST is required; never guess it');
  safeTree(conditionAst);
  return {
    name: 'Filter v2.3 boolean equals fixture',
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'trigger', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [240, 300], parameters: {} },
      { id: 'todos', name: 'Fetch Todos', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [500, 300], parameters: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos?userId=1', options: {} } },
      { id: 'filter', name: 'Filter Completed', type: FILTER_NODE_TYPE, typeVersion: FILTER_TYPE_VERSION, position: [760, 300], parameters: { conditions: conditionAst, looseTypeValidation: false, options: { ignoreCase: false } } },
      { id: 'count', name: 'Count Filtered', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1020, 300], parameters: { jsCode: 'const records = $input.all().map((item) => item.json);\nconst falseCount = records.filter((record) => record.completed === false).length;\nreturn [{ json: { totalTodos: records.length, incompleteTodos: falseCount } }];' } },
      { id: 'output', name: 'Output', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [1280, 300], parameters: { assignments: { assignments: [{ name: 'totalTodos', value: '={{ $json.totalTodos }}', type: 'number' }, { name: 'incompleteTodos', value: '={{ $json.incompleteTodos }}', type: 'number' }] }, includeOtherFields: false, options: {} } },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Fetch Todos', type: 'main', index: 0 }]] },
      'Fetch Todos': { main: [[{ node: 'Filter Completed', type: 'main', index: 0 }]] },
      'Filter Completed': { main: [[{ node: 'Count Filtered', type: 'main', index: 0 }]] },
      'Count Filtered': { main: [[{ node: 'Output', type: 'main', index: 0 }]] },
    },
  };
}

function readbackChecks(workflow, conditionAst) {
  assert(workflow && Array.isArray(workflow.nodes), 'filter readback nodes missing');
  const node = workflow.nodes.find((candidate) => candidate.type === FILTER_NODE_TYPE);
  assert(node, 'filter node missing from readback');
  const outputs = workflow.connections && workflow.connections['Filter Completed'] && workflow.connections['Filter Completed'].main;
  return {
    node_type: node.type === FILTER_NODE_TYPE,
    node_version: node.typeVersion === FILTER_TYPE_VERSION,
    condition_ast_exact: JSON.stringify(node.parameters && node.parameters.conditions) === JSON.stringify(conditionAst),
    one_connected_main_output: Array.isArray(outputs) && outputs.length === 1 && Array.isArray(outputs[0]) && outputs[0].length === 1,
    no_discarded_branch: !(workflow.connections && workflow.connections['Filter Completed'] && workflow.connections['Filter Completed'].main && workflow.connections['Filter Completed'].main[1]),
    inactive: workflow.active === false,
  };
}

function executionChecks(facts) {
  assert(facts && typeof facts === 'object' && !Array.isArray(facts), 'filter execution facts missing');
  return {
    executed: facts.executed === true,
    filtered_items_numeric: Number.isInteger(facts.filteredItems) && facts.filteredItems >= 0,
    all_completed_false: facts.allCompletedFalse === true,
    final_total_numeric: typeof facts.totalTodos === 'number' && Number.isFinite(facts.totalTodos),
    final_incomplete_numeric: typeof facts.incompleteTodos === 'number' && Number.isFinite(facts.incompleteTodos),
  };
}

async function runFilterFixture({ api, conditionAst } = {}) {
  assert(api && ['createWorkflow', 'getWorkflow', 'executeFilterWebhook', 'deactivateWorkflow', 'deleteWorkflow'].every((method) => typeof api[method] === 'function'), 'filter acceptance API is incomplete');
  const workflow = buildFilterFixture(conditionAst);
  let workflowId = null;
  const result = { fixture: FILTER_FIXTURE_ID, readback: { pass: false, checks: {} }, execution: { pass: false, checks: {} }, pass: false };
  try {
    const created = await api.createWorkflow(workflow);
    workflowId = created && created.id;
    assert(validId(workflowId), 'filter fixture create returned no usable id');
    const readback = await api.getWorkflow(workflowId);
    const checks = readbackChecks(readback, conditionAst);
    result.readback = { pass: Object.values(checks).every(Boolean), checks };
    if (!result.readback.pass) return result;
    const facts = await api.executeFilterWebhook(workflowId, FILTER_FIXTURE_ID);
    const execution = executionChecks(facts);
    result.execution = { pass: Object.values(execution).every(Boolean), checks: execution };
    result.pass = result.execution.pass;
    return result;
  } catch (_) {
    result.failure = { phase: result.readback.pass ? 'execute' : 'create_or_readback', code: 'filter_fixture_failed' };
    return result;
  } finally {
    if (workflowId) {
      try { await api.deactivateWorkflow(workflowId); } catch (_) { result.cleanup = 'failed'; }
      try { await api.deleteWorkflow(workflowId); } catch (_) { result.cleanup = 'failed'; }
      if (result.cleanup === 'failed') result.pass = false;
    }
  }
}

module.exports = { FILTER_FIXTURE_ID, FILTER_NODE_TYPE, FILTER_TYPE_VERSION, buildFilterFixture, readbackChecks, executionChecks, runFilterFixture };
