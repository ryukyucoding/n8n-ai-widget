'use strict';

const { compileStepSpecification } = require('./runtimeCompiler');
const { smokeSpecification } = require('./runRuntimeCompilerSmoke');
const { verifyCandidateWorkflow } = require('../../chatbot/src/candidateWorkflowVerifier');
const { sanitizeCreateWorkflowPayload } = require('../../chatbot/src/workflowCreatePayload');

const PREFIX = '__autoresearch_nodewise_compiler__';

function headers() {
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) throw new Error('N8N_API_KEY is required');
  return { 'content-type': 'application/json', 'X-N8N-API-KEY': apiKey };
}

function baseUrl() {
  const value = process.env.N8N_BASE_URL;
  if (!value) throw new Error('N8N_BASE_URL is required');
  return value.replace(/\/$/, '');
}

function safeReport({ workflow, verification, created, readback, prefix = PREFIX }) {
  return {
    schemaVersion: '1.0', kind: 'nodewise_runtime_compiler_provisioning', executionPolicy: 'manual_ui_execution_required',
    outcome: 'created_readback_verified', workflowId: String(created.id), workflowName: created.name,
    inactive: readback.active === false,
    verificationStatus: verification.status,
    nodeCards: workflow.nodes.map((node) => ({ type: node.type, typeVersion: node.typeVersion })),
    cleanup: { eligible: true, exactWorkflowId: String(created.id), prefix },
  };
}

async function createFailure(response) {
  let body = '';
  try { body = await response.text(); } catch {}
  const normalized = String(body).toLowerCase();
  let category = 'n8n_validation_failed';
  if (normalized.includes('additional properties')) category = 'unexpected_workflow_property';
  else if (normalized.includes('uuid') || normalized.includes('node id') || normalized.includes('nodes')) category = 'node_schema_rejected';
  else if (normalized.includes('connection')) category = 'connection_schema_rejected';
  return new Error(`workflow_create_failed_${response.status}:${category}`);
}

async function provision({ fetchImpl = globalThis.fetch, specification = smokeSpecification(), userRequest = 'Read public JSONPlaceholder post 1 and return id and title.', prefix = PREFIX } = {}) {
  const workflow = compileStepSpecification({ specification });
  workflow.name = `${prefix}${Date.now()}`;
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest, candidateWorkflow: workflow }, { n8nBaseUrl: baseUrl(), n8nApiKey: process.env.N8N_API_KEY });
  if (!['pass', 'warning'].includes(verification.status)) throw new Error('compiler_workflow_static_verification_failed');
  const payload = sanitizeCreateWorkflowPayload(verification.workflow);
  const createdResponse = await fetchImpl(`${baseUrl()}/api/v1/workflows`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
  if (!createdResponse.ok) throw await createFailure(createdResponse);
  const created = await createdResponse.json();
  if (!created?.id || !String(created.name).startsWith(prefix)) throw new Error('created_workflow_identity_rejected');
  const readbackResponse = await fetchImpl(`${baseUrl()}/api/v1/workflows/${encodeURIComponent(created.id)}`, { headers: headers() });
  if (!readbackResponse.ok) throw new Error(`workflow_readback_failed_${readbackResponse.status}`);
  const readback = await readbackResponse.json();
  if (String(readback?.id) !== String(created.id) || readback?.name !== created.name || readback?.active !== false) throw new Error('workflow_readback_identity_rejected');
  return safeReport({ workflow: verification.workflow, verification, created, readback, prefix });
}

async function main() {
  const report = await provision();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { PREFIX, createFailure, provision, safeReport };
