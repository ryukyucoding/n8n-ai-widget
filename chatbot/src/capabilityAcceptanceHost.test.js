'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TARGET, normalizeBase, createN8nAcceptanceApi, createCapabilityAcceptanceHost, runCapabilityAcceptanceCommand } = require('./capabilityAcceptanceHost');

test('host command fails closed without the exact server-side target', async () => {
  const result = await runCapabilityAcceptanceCommand({ env: {}, executeWorkflow: async () => ({}) });
  assert.deepEqual(result, { status: 'backend_unavailable', reason: 'target_not_authorized' });
});

test('host command requires all server dependencies and a reviewed executor', async () => {
  const env = { CAPABILITY_ACCEPTANCE_TARGET: TARGET, N8N_BASE_URL: 'http://n8n.test', N8N_API_KEY: 'server-only', PLANNER_APPROVAL_HMAC_SECRET: 'a'.repeat(32) };
  assert.deepEqual(await runCapabilityAcceptanceCommand({ env }), { status: 'backend_unavailable', reason: 'verified_execution_adapter_missing' });
  assert.deepEqual(await runCapabilityAcceptanceCommand({ env: { ...env, PLANNER_APPROVAL_HMAC_SECRET: '' }, executeWorkflow: async () => ({}) }), { status: 'backend_unavailable', reason: 'required_server_dependency_missing' });
});

test('base URL rejects credentials/query/hash and normalizes trailing slash', () => {
  assert.equal(normalizeBase('http://n8n.test/'), 'http://n8n.test');
  assert.equal(normalizeBase('http://user:pass@n8n.test'), null);
  assert.equal(normalizeBase('http://n8n.test?x=1'), null);
  assert.equal(normalizeBase('not a URL'), null);
});

test('n8n API adapter keeps the server key in the request closure and returns no auth metadata', async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200, async json() { return { id: 'wf1', active: false }; } };
  };
  const api = createN8nAcceptanceApi({ baseUrl: 'http://n8n.test', apiKey: 'server-only', fetchImpl });
  const result = await api.createWorkflow({ name: 'fixed', active: false, id: 'private-id', secret: 'drop' });
  assert.deepEqual(result, { id: 'wf1', active: false });
  assert.equal(seen.options.headers['X-N8N-API-KEY'], 'server-only');
  const body = JSON.parse(seen.options.body);
  assert.deepEqual(body, { name: 'fixed' });
  assert.doesNotMatch(JSON.stringify(api), /server-only/);
});

test('host only accepts fixed command and exposes fixed fixture ids', () => {
  const env = { CAPABILITY_ACCEPTANCE_TARGET: TARGET, N8N_BASE_URL: 'http://n8n.test', N8N_API_KEY: 'server-only', PLANNER_APPROVAL_HMAC_SECRET: 'a'.repeat(32) };
  const host = createCapabilityAcceptanceHost({ env, fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }), executeWorkflow: async () => ({}) });
  assert.deepEqual(host.fixtureIds, ['schedule_todo_summary', 'slice_todo_page', 'set_fields_user', 'current_date']);
});
