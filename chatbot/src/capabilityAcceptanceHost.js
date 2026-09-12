'use strict';

// Narrow host adapter for the fixed capability acceptance backend. It uses the
// server's n8n API key only inside request closures and never logs response
// bodies, keys, workflow ids, or raw workflow data. No CLI arguments are used.

const { createCapabilityAcceptanceBackend } = require('./capabilityAcceptanceBackend');
const { createFixedWebhookExecutionAdapter } = require('./capabilityAcceptanceExecution');
const { approveNodewisePlan, compileApprovedNodewisePlan } = require('./approvedNodewiseCompiler');

const TARGET = 'isolated-chatbot';
const REQUIRED_ENV = ['N8N_BASE_URL', 'N8N_API_KEY', 'PLANNER_APPROVAL_HMAC_SECRET'];

function unavailable(reason) {
  return { status: 'backend_unavailable', reason };
}

function normalizeBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch (_) { return null; }
}

function createN8nAcceptanceApi({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
  const base = normalizeBase(baseUrl);
  if (!base || typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function') return null;
  async function request(method, path, body, allowEmpty = false) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': apiKey, Connection: 'close' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok || (!allowEmpty && (!payload || typeof payload !== 'object' || Array.isArray(payload)))) {
      throw new Error(`n8n_acceptance_http_${response.status}`);
    }
    return payload;
  }
  return {
    createWorkflow: (workflow) => request('POST', '/api/v1/workflows', workflow),
    getWorkflow: (id) => request('GET', `/api/v1/workflows/${encodeURIComponent(String(id))}`),
    activateWorkflow: (id) => request('POST', `/api/v1/workflows/${encodeURIComponent(String(id))}/activate`, undefined, true),
    deactivateWorkflow: (id) => request('POST', `/api/v1/workflows/${encodeURIComponent(String(id))}/deactivate`, undefined, true),
    deleteWorkflow: (id) => request('DELETE', `/api/v1/workflows/${encodeURIComponent(String(id))}`, undefined, true),
    listExecutions: (id) => request('GET', `/api/v1/executions?limit=10&includeData=false&workflowId=${encodeURIComponent(String(id))}`),
    getExecution: (id) => request('GET', `/api/v1/executions/${encodeURIComponent(String(id))}?includeData=true`),
    async triggerWebhook(path, publicBaseUrl) {
      const base = normalizeBase(publicBaseUrl);
      if (!base || !/^capability-acceptance-[a-z0-9_]+$/.test(path)) throw new Error('fixed webhook target is invalid');
      const response = await fetchImpl(`${base}/webhook/${encodeURIComponent(path)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: '{}',
      });
      if (!response.ok) throw new Error(`n8n_acceptance_webhook_http_${response.status}`);
      return response.status;
    },
  };
}

function createCapabilityAcceptanceHost({ env = process.env, fetchImpl = globalThis.fetch, executeWorkflow } = {}) {
  // The target is a fixed server-side deployment setting, never a CLI/body arg.
  if (env.CAPABILITY_ACCEPTANCE_TARGET !== TARGET) return { run: async () => unavailable('target_not_authorized') };
  if (REQUIRED_ENV.some((key) => typeof env[key] !== 'string' || !env[key])) return { run: async () => unavailable('required_server_dependency_missing') };
  const n8n = createN8nAcceptanceApi({ baseUrl: env.N8N_BASE_URL, apiKey: env.N8N_API_KEY, fetchImpl });
  if (!n8n) return { run: async () => unavailable('n8n_api_adapter_unavailable') };
  let execution = typeof executeWorkflow === 'function' ? { executeWorkflow } : null;
  if (!execution && typeof env.N8N_PUBLIC_URL === 'string') {
    try { execution = createFixedWebhookExecutionAdapter({ n8n, publicBaseUrl: env.N8N_PUBLIC_URL }); } catch (_) { execution = null; }
  }
  if (!execution) return { run: async () => unavailable('verified_execution_adapter_missing') };
  const backend = createCapabilityAcceptanceBackend({
    n8n: { ...n8n, ...execution },
    approve: approveNodewisePlan,
    compileApproved: compileApprovedNodewisePlan,
    secret: env.PLANNER_APPROVAL_HMAC_SECRET,
  });
  return { run: () => backend.runBatch(), fixtureIds: backend.fixtureIds };
}

// Fixed no-argument command contract. It intentionally remains blocked unless
// a reviewed host supplies executeWorkflow; no arbitrary execution fallback.
async function runCapabilityAcceptanceCommand(options = {}) {
  const host = createCapabilityAcceptanceHost(options);
  return host.run();
}

if (require.main === module) {
  runCapabilityAcceptanceCommand().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`));
}

module.exports = { TARGET, REQUIRED_ENV, normalizeBase, createN8nAcceptanceApi, createCapabilityAcceptanceHost, runCapabilityAcceptanceCommand };
