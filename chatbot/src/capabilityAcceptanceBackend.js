'use strict';

// Fixed server-side acceptance backend for the four credential-free fixtures.
// All n8n effects are injected so the contract can be tested without a host,
// API key, or real workflow. No caller-supplied workflow/spec/path is accepted.

const { compileNodewiseSpecification } = require('./nodewiseCompiler');

const FIXTURE_IDS = Object.freeze(['schedule_todo_summary', 'slice_todo_page', 'set_fields_user', 'current_date']);

function assert(condition, message) { if (!condition) throw new Error(message); }
function validId(id) { return (typeof id === 'string' || typeof id === 'number') && /^[A-Za-z0-9_-]{1,128}$/.test(String(id)); }
function number(value) { return typeof value === 'number' && Number.isFinite(value); }
function text(value) { return typeof value === 'string' && value.length <= 512; }

function fixedSpecifications() {
  const source = (reference, cardinality) => ({ kind: 'public_literal', reference, cardinality });
  const prior = (reference, cardinality) => ({ kind: 'prior_step', reference, cardinality });
  return {
    schedule_todo_summary: {
      schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Every 15 minutes count incomplete todos.', requiredUserSetup: [],
      expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] },
      steps: [
        { id: 'schedule', capability: 'schedule_trigger', requiredUserSetup: [], configuration: { interval: 'minutes', intervalValue: 15 } },
        { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: source('https://jsonplaceholder.typicode.com/todos?userId=1', 'items') } },
        { id: 'count', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: prior('todos.response', 'items'), field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
        { id: 'output', capability: 'set_output', requiredUserSetup: [], configuration: { input: prior('count.response', 'one_object'), mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }, { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' }] } },
      ],
    },
    slice_todo_page: {
      schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Count the second page of todos.', requiredUserSetup: [],
      expectedOutput: { deliveryShape: 'one_object', fields: ['totalTodos', 'incompleteTodos'] },
      steps: [
        { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
        { id: 'todos', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: source('https://jsonplaceholder.typicode.com/todos?userId=1', 'items') } },
        { id: 'page', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'slice_items', input: prior('todos.response', 'items'), offset: 5, limit: 5 } },
        { id: 'count', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'count_false_boolean', input: prior('page.response', 'items'), field: 'completed', totalField: 'totalTodos', falseCountField: 'incompleteTodos' } },
        { id: 'output', capability: 'set_output', requiredUserSetup: [], configuration: { input: prior('count.response', 'one_object'), mappings: [{ from: 'totalTodos', to: 'totalTodos', valueType: 'number' }, { from: 'incompleteTodos', to: 'incompleteTodos', valueType: 'number' }] } },
      ],
    },
    set_fields_user: {
      schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Map a public user with typed fields.', requiredUserSetup: [],
      expectedOutput: { deliveryShape: 'one_object', fields: ['name', 'status', 'isActive'] },
      steps: [
        { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
        { id: 'user', capability: 'http_request', requiredUserSetup: [], configuration: { method: 'GET', url: source('https://jsonplaceholder.typicode.com/users/5', 'one_object') } },
        { id: 'mapped', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'set_fields', input: prior('user.response', 'one_object'), mappings: [
          { to: 'name', valueType: 'string', source: { kind: 'input_field', field: 'name' } },
          { to: 'status', valueType: 'string', source: { kind: 'literal', value: 'active' } },
          { to: 'isActive', valueType: 'boolean', source: { kind: 'literal', value: true } },
        ] } },
      ],
    },
    current_date: {
      schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'Return the current date.', requiredUserSetup: [],
      expectedOutput: { deliveryShape: 'one_object', fields: ['currentDate'] },
      steps: [
        { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
        { id: 'today', capability: 'data_transform', requiredUserSetup: [], configuration: { operation: 'current_date', includeTime: false, outputFieldName: 'currentDate' } },
      ],
    },
  };
}

function readbackChecks(id, workflow) {
  assert(workflow && Array.isArray(workflow.nodes), 'readback nodes missing');
  const nodes = workflow.nodes;
  if (id === 'schedule_todo_summary') {
    const node = nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    return { schedule_node: Boolean(node), schedule_parameters: Boolean(node && node.parameters && node.parameters.rule && node.parameters.rule.interval && node.parameters.rule.interval[0] && node.parameters.rule.interval[0].minutesInterval === 15), inactive: workflow.active === false };
  }
  if (id === 'slice_todo_page') {
    const node = nodes.find((n) => n.name && /page/.test(n.name));
    return { slice_code: Boolean(node && node.type === 'n8n-nodes-base.code' && /records\.slice\(5, 10\)/.test(node.parameters.jsCode || '')), inactive: workflow.active === false };
  }
  if (id === 'set_fields_user') {
    const node = nodes.at(-1);
    const assignments = node && node.parameters && node.parameters.assignments && node.parameters.assignments.assignments;
    return { set_node: Boolean(node && node.type === 'n8n-nodes-base.set'), assignment_count: Array.isArray(assignments) && assignments.length === 3, inactive: workflow.active === false };
  }
  const node = nodes.find((n) => n.type === 'n8n-nodes-base.dateTime');
  return { date_node: Boolean(node), date_parameters: Boolean(node && node.typeVersion === 2 && node.parameters && node.parameters.operation === 'getCurrentDate' && node.parameters.includeTime === false), inactive: workflow.active === false };
}

function executionChecks(id, facts) {
  assert(facts && typeof facts === 'object' && !Array.isArray(facts), 'execution facts missing');
  const checks = { executed: facts.executed === true };
  if (id === 'schedule_todo_summary') {
    checks.total_numeric = number(facts.totalTodos);
    checks.incomplete_numeric = number(facts.incompleteTodos);
  } else if (id === 'slice_todo_page') {
    checks.total_five = facts.totalTodos === 5;
    checks.ids_second_page = JSON.stringify(facts.retainedIds) === JSON.stringify([6, 7, 8, 9, 10]);
    checks.incomplete_numeric = number(facts.incompleteTodos);
  } else if (id === 'set_fields_user') {
    checks.name_string = typeof facts.name === 'string';
    checks.status_string = facts.status === 'active' && typeof facts.status === 'string';
    checks.active_boolean = facts.isActive === true && typeof facts.isActive === 'boolean';
  } else {
    checks.date_string = typeof facts.currentDate === 'string' && facts.currentDate.length > 0;
  }
  return checks;
}

function safeExecutionFacts(id, facts) {
  const out = { executed: facts && facts.executed === true };
  if (id === 'schedule_todo_summary' || id === 'slice_todo_page') {
    if (number(facts && facts.totalTodos)) out.totalTodos = facts.totalTodos;
    if (number(facts && facts.incompleteTodos)) out.incompleteTodos = facts.incompleteTodos;
  }
  if (id === 'slice_todo_page' && Array.isArray(facts && facts.retainedIds) && facts.retainedIds.every((v) => Number.isInteger(v))) out.retainedIds = facts.retainedIds.slice(0, 20);
  if (id === 'set_fields_user') {
    if (typeof (facts && facts.name) === 'string') out.name = facts.name.slice(0, 256);
    if (typeof (facts && facts.status) === 'string') out.status = facts.status.slice(0, 64);
    if (typeof (facts && facts.isActive) === 'boolean') out.isActive = facts.isActive;
  }
  if (id === 'current_date' && typeof (facts && facts.currentDate) === 'string') out.currentDate = facts.currentDate.slice(0, 128);
  return out;
}

function createCapabilityAcceptanceBackend({ n8n, approve, compileApproved, secret, sessionPrefix = 'capability-acceptance' } = {}) {
  assert(n8n && typeof n8n.createWorkflow === 'function' && typeof n8n.getWorkflow === 'function' && typeof n8n.executeWorkflow === 'function' && typeof n8n.deactivateWorkflow === 'function' && typeof n8n.deleteWorkflow === 'function', 'n8n acceptance API is incomplete');
  assert(typeof approve === 'function' && typeof compileApproved === 'function' && typeof secret === 'string' && secret.length >= 32, 'approval dependencies are incomplete');
  const specs = fixedSpecifications();

  async function runFixture(fixtureId) {
    assert(FIXTURE_IDS.includes(fixtureId), 'fixture is not in the fixed acceptance allowlist');
    const spec = specs[fixtureId];
    const sessionId = `${sessionPrefix}-${fixtureId}`;
    let workflowId = null;
    const result = { fixture: fixtureId, readback: { pass: false, checks: {} }, execution: { pass: false, checks: {} }, pass: false };
    try {
      const approval = approve(spec, { secret, sessionId });
      const compiled = compileApproved(spec, approval.approvalToken, { secret, sessionId });
      const created = await n8n.createWorkflow(compiled.workflow);
      workflowId = created && created.id;
      assert(validId(workflowId), 'created workflow has no usable id');
      let readback = await n8n.getWorkflow(workflowId);
      if (readback.active === true) {
        await n8n.deactivateWorkflow(workflowId);
        readback = await n8n.getWorkflow(workflowId);
      }
      const readChecks = readbackChecks(fixtureId, readback);
      result.readback = { pass: Object.values(readChecks).every(Boolean), checks: readChecks };
      if (!result.readback.pass) return result;
      const facts = await n8n.executeWorkflow(workflowId, fixtureId);
      const sanitized = safeExecutionFacts(fixtureId, facts);
      const execChecks = executionChecks(fixtureId, sanitized);
      result.execution = { pass: Object.values(execChecks).every(Boolean), checks: execChecks };
      result.pass = result.readback.pass && result.execution.pass;
      return result;
    } catch (_) {
      return result;
    } finally {
      if (workflowId) {
        let cleanupFailed = false;
        try { await n8n.deactivateWorkflow(workflowId); } catch (_) { cleanupFailed = true; }
        try { await n8n.deleteWorkflow(workflowId); } catch (_) { cleanupFailed = true; }
        if (cleanupFailed) {
          result.pass = false;
          result.cleanupWarning = 'cleanup_failed';
        }
      }
    }
  }

  async function runBatch() {
    const results = [];
    for (const fixtureId of FIXTURE_IDS) {
      const result = await runFixture(fixtureId);
      results.push(result);
      if (!result.pass) return { schema: 'capability_acceptance/v1', status: 'failed', results, stoppedAfter: fixtureId };
    }
    return { schema: 'capability_acceptance/v1', status: 'passed', results };
  }

  return { runFixture, runBatch, fixtureIds: FIXTURE_IDS, compileFixture: (id) => compileNodewiseSpecification(specs[id]) };
}

module.exports = { FIXTURE_IDS, fixedSpecifications, readbackChecks, executionChecks, safeExecutionFacts, createCapabilityAcceptanceBackend };
