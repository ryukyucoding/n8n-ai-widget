'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compileDailyRssDigestSpecification } = require('./rssDigestCompiler');
const { verifyCandidateWorkflow } = require('./candidateWorkflowVerifier');
const { sanitizeCreateWorkflowPayload } = require('./workflowCreatePayload');

async function main() {
  const specificationPath = process.argv[2];
  if (!specificationPath) throw new Error('usage: node rssDigestCompilerTrial.js <specification.json>');
  if (!process.env.N8N_API_KEY || !process.env.N8N_BASE_URL) throw new Error('N8N_API_KEY and N8N_BASE_URL are required');
  const specification = JSON.parse(fs.readFileSync(path.resolve(specificationPath), 'utf8'));
  const workflow = compileDailyRssDigestSpecification(specification);
  workflow.name = `__rss_digest_compiler_trial__${Date.now()}`;
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest: specification.goal, candidateWorkflow: workflow }, { n8nBaseUrl: process.env.N8N_BASE_URL, n8nApiKey: process.env.N8N_API_KEY });
  if (!['pass', 'warning'].includes(verification.status)) throw new Error(`candidate verification failed: ${verification.status}`);
  const createResponse = await fetch(`${process.env.N8N_BASE_URL}/api/v1/workflows`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': process.env.N8N_API_KEY, Connection: 'close' }, body: JSON.stringify(sanitizeCreateWorkflowPayload(verification.workflow)) });
  if (!createResponse.ok) throw new Error(`n8n create failed: ${createResponse.status}`);
  const created = await createResponse.json();
  const readbackResponse = await fetch(`${process.env.N8N_BASE_URL}/api/v1/workflows/${encodeURIComponent(created.id)}`, { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY, Connection: 'close' } });
  if (!readbackResponse.ok) throw new Error(`n8n readback failed: ${readbackResponse.status}`);
  const readback = await readbackResponse.json();
  if (readback.name !== created.name || readback.nodes?.length !== workflow.nodes.length) throw new Error('n8n readback does not match created workflow identity');
  process.stdout.write(`${JSON.stringify({ schemaVersion: '1.0', kind: 'daily_rss_digest_compiler_trial', executionPolicy: 'manual_ui_execution_required', status: 'created_readback_verified', workflowId: created.id, workflowName: created.name, nodeCount: readback.nodes.length, active: readback.active === true })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
