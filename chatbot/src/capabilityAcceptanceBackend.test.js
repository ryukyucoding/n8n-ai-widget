'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE_IDS, fixedSpecifications, createCapabilityAcceptanceBackend } = require('./capabilityAcceptanceBackend');

const SECRET = 'test-only-approval-secret-value-32chars';
const workflows = new Map();

function fakeN8n({ failAt = null } = {}) {
  const calls = [];
  return {
    calls,
    async createWorkflow(workflow) {
      calls.push('create');
      const id = `wf-${workflows.size + 1}`;
      workflows.set(id, { ...workflow, id, active: false });
      return { id, active: false };
    },
    async getWorkflow(id) {
      calls.push('get');
      return workflows.get(id);
    },
    async executeWorkflow(id, fixtureId) {
      calls.push(`execute:${fixtureId}`);
      if (fixtureId === failAt) return { executed: true };
      if (fixtureId === 'schedule_todo_summary') return { executed: true, totalTodos: 20, incompleteTodos: 9 };
      if (fixtureId === 'slice_todo_page') return { executed: true, totalTodos: 5, incompleteTodos: 2, retainedIds: [6, 7, 8, 9, 10] };
      if (fixtureId === 'set_fields_user') return { executed: true, name: 'Chelsey Dietrich', status: 'active', isActive: true };
      return { executed: true, currentDate: '2026-09-13' };
    },
    async deactivateWorkflow(id) { calls.push('deactivate'); const wf = workflows.get(id); if (wf) wf.active = false; },
    async deleteWorkflow(id) { calls.push('delete'); workflows.delete(id); },
  };
}

function backendFor(options = {}) {
  return createCapabilityAcceptanceBackend({
    n8n: fakeN8n(options),
    approve: (spec, opts) => ({ approvalToken: { spec, ...opts } }),
    compileApproved: (spec) => ({ workflow: { ...spec, nodes: spec.steps.map((step, i) => ({ name: `Step ${i + 1}: ${step.id}`, type: step.capability === 'schedule_trigger' ? 'n8n-nodes-base.scheduleTrigger' : step.capability === 'data_transform' && step.configuration.operation === 'current_date' ? 'n8n-nodes-base.dateTime' : step.capability === 'data_transform' && step.configuration.operation === 'set_fields' ? 'n8n-nodes-base.set' : step.capability === 'data_transform' && step.configuration.operation === 'slice_items' ? 'n8n-nodes-base.code' : 'n8n-nodes-base.httpRequest', typeVersion: step.configuration.operation === 'current_date' ? 2 : 1, parameters: step.capability === 'schedule_trigger' ? { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } : step.configuration.operation === 'current_date' ? { operation: 'getCurrentDate', includeTime: false } : step.configuration.operation === 'slice_items' ? { jsCode: 'records.slice(5, 10)' } : step.configuration.operation === 'set_fields' ? { assignments: { assignments: [{}, {}, {}] } } : {} })) } }),
    secret: SECRET,
  });
}

test('backend exposes exactly four fixed fixtures and rejects arbitrary fixture ids', async () => {
  const backend = backendFor();
  assert.deepEqual(backend.fixtureIds, FIXTURE_IDS);
  await assert.rejects(() => backend.runFixture('other-workflow'), /fixed acceptance allowlist/);
});

test('backend runs all four fixtures, enforces inactive cleanup, and returns sanitized results', async () => {
  const backend = backendFor();
  const result = await backend.runBatch();
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.results.map((item) => item.fixture), FIXTURE_IDS);
  assert.ok(result.results.every((item) => item.pass));
  assert.doesNotMatch(JSON.stringify(result), /workflowId|Chelsey|2026-09-13/);
});

test('backend stops after first failure and cleans the failed fixture', async () => {
  const backend = backendFor({ failAt: 'slice_todo_page' });
  const result = await backend.runBatch();
  assert.equal(result.status, 'failed');
  assert.equal(result.stoppedAfter, 'slice_todo_page');
  assert.deepEqual(result.results.map((item) => item.fixture), ['schedule_todo_summary', 'slice_todo_page']);
});

test('backend requires n8n API and approval dependencies at construction', () => {
  assert.throws(() => createCapabilityAcceptanceBackend({}), /n8n acceptance API/);
  assert.throws(() => createCapabilityAcceptanceBackend({ n8n: fakeN8n() }), /approval dependencies/);
  assert.deepEqual(Object.keys(fixedSpecifications()).sort(), FIXTURE_IDS.slice().sort());
});
