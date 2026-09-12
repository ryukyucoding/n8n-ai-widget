'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixedWebhookExecutionAdapter, transformTrigger, finishedExecution, extractFacts } = require('./capabilityAcceptanceExecution');

function runData(items) { return { data: { main: [[...items.map((json) => ({ json }))]] } }; }

function fakeN8n() {
  const calls = [];
  const original = { nodes: [{ name: 'Step 1: start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }, { name: 'Step 2: today', type: 'n8n-nodes-base.dateTime', parameters: {} }] };
  return {
    calls,
    async getWorkflow(id) { calls.push(['get', id]); return original; },
    async createWorkflow(wf) { calls.push(['create', wf.nodes[0].type]); return { id: 'variant-1' }; },
    async activateWorkflow(id) { calls.push(['activate', id]); },
    async triggerWebhook(path) { calls.push(['trigger', path]); return 200; },
    async listExecutions(id) { calls.push(['list', id]); return { data: [{ id: 'exec-1', workflowId: id, finished: true, startedAt: new Date().toISOString() }] }; },
    async getExecution(id) { calls.push(['exec', id]); return { data: { resultData: { runData: { 'Step 2: today': [runData([{ currentDate: '2026-09-13' }])] } } } }; },
    async deactivateWorkflow(id) { calls.push(['deactivate', id]); },
    async deleteWorkflow(id) { calls.push(['delete', id]); },
  };
}

test('transformTrigger replaces exactly one fixed trigger and preserves downstream names', () => {
  const out = transformTrigger({ nodes: [{ name: 'start', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} }], connections: {} }, 'current_date');
  assert.equal(out.workflow.nodes[0].type, 'n8n-nodes-base.webhook');
  assert.equal(out.workflow.nodes[0].typeVersion, 2.1);
  assert.deepEqual(out.workflow.nodes[0].parameters, { httpMethod: 'POST', path: 'capability-acceptance-current_date', responseMode: 'onReceived', options: {} });
  assert.throws(() => transformTrigger({ nodes: [] }, 'current_date'), /exactly one trigger/);
});

test('finishedExecution binds only a fresh finished execution for the exact workflow', () => {
  const now = Date.now();
  assert.equal(finishedExecution({ data: [
    { id: 'old', workflowId: 'other', finished: true, startedAt: new Date(now).toISOString() },
    { id: 'new', workflowId: 'wf', finished: true, startedAt: new Date(now).toISOString() },
    { id: 'running', workflowId: 'wf', finished: false, startedAt: new Date(now).toISOString() },
  ] }, 'wf', now - 1000).id, 'new');
  assert.equal(finishedExecution({ data: [{ id: 'bad-time', workflowId: 'wf', finished: true }] }, 'wf', now - 1000), null);
});

test('extractFacts returns only fixed fixture facts', () => {
  const data = { 'Step 4: output': [runData([{ totalTodos: 20, incompleteTodos: 9, secret: 'drop' }])], 'Step 3: page': [runData([{ id: 6 }, { id: 7 }])] };
  assert.deepEqual(extractFacts('schedule_todo_summary', data), { executed: true, totalTodos: 20, incompleteTodos: 9, retainedIds: [] });
});

test('fixed execution adapter uses webhook harness and always cleans the variant', async () => {
  const n8n = fakeN8n();
  const adapter = createFixedWebhookExecutionAdapter({ n8n, publicBaseUrl: 'http://n8n.test', now: () => Date.now(), sleep: async () => {} });
  const result = await adapter.executeWorkflow('original-1', 'current_date');
  assert.deepEqual(result, { executed: true, currentDate: '2026-09-13', executionStatus: 'webhook_harness_dataflow_verified' });
  assert.deepEqual(n8n.calls.map((call) => call[0]), ['get', 'create', 'activate', 'trigger', 'list', 'exec', 'deactivate', 'delete']);
});

test('fixed execution adapter rejects arbitrary fixture ids and invalid public base', async () => {
  assert.throws(() => createFixedWebhookExecutionAdapter({ n8n: fakeN8n(), publicBaseUrl: 'http://n8n.test/path' }), /base URL/);
  const adapter = createFixedWebhookExecutionAdapter({ n8n: fakeN8n(), publicBaseUrl: 'http://n8n.test' });
  await assert.rejects(() => adapter.executeWorkflow('original-1', 'other'), /fixed acceptance allowlist/);
});
