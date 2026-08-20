'use strict';

const { compileStepSpecification } = require('./runtimeCompiler');
const { smokeSpecification } = require('./runRuntimeCompilerSmoke');
const { verifyCandidateWorkflow } = require('../../chatbot/src/candidateWorkflowVerifier');

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

function safeReport({ workflow, verification, created, readback }) {
  return {
    schemaVersion: '1.0', kind: 'nodewise_runtime_compiler_provisioning', executionPolicy: 'manual_ui_execution_required',
    outcome: 'created_readback_verified', workflowId: String(created.id), workflowName: created.name,
    inactive: readback.active === false,
    verificationStatus: verification.status,
    nodeCards: workflow.nodes.map((node) => ({ type: node.type, typeVersion: node.typeVersion })),
    cleanup: { eligible: true, exactWorkflowId: String(created.id), prefix: PREFIX },
  };
}

async function provision({ fetchImpl = globalThis.fetch } = {}) {
  const workflow = compileStepSpecification({ specification: smokeSpecification() });
  workflow.name = `${PREFIX}${Date.now()}`;
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest: 'Read public JSONPlaceholder post 1 and return id and title.', candidateWorkflow: workflow }, { n8nBaseUrl: baseUrl(), n8nApiKey: process.env.N8N_API_KEY });
  if (!['pass', 'warning'].includes(verification.status)) throw new Error('compiler_workflow_static_verification_failed');
  const createdResponse = await fetchImpl(`${baseUrl()}/api/v1/workflows`, { method: 'POST', headers: headers(), body: JSON.stringify(verification.workflow) });
  if (!createdResponse.ok) throw new Error(`workflow_create_failed_${createdResponse.status}`);
  const created = await createdResponse.json();
  if (!created?.id || !String(created.name).startsWith(PREFIX)) throw new Error('created_workflow_identity_rejected');
  const readbackResponse = await fetchImpl(`${baseUrl()}/api/v1/workflows/${encodeURIComponent(created.id)}`, { headers: headers() });
  if (!readbackResponse.ok) throw new Error(`workflow_readback_failed_${readbackResponse.status}`);
  const readback = await readbackResponse.json();
  if (String(readback?.id) !== String(created.id) || readback?.name !== created.name || readback?.active !== false) throw new Error('workflow_readback_identity_rejected');
  return safeReport({ workflow: verification.workflow, verification, created, readback });
}

async function main() {
  const report = await provision();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { PREFIX, provision, safeReport };
