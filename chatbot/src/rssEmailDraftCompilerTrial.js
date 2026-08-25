'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compileDailyRssEmailDraft } = require('./rssEmailDraftCompiler');
const { sanitizeCreateWorkflowPayload } = require('./workflowCreatePayload');

async function main() {
  const specificationPath = process.argv[2];
  if (!specificationPath) throw new Error('usage: node rssEmailDraftCompilerTrial.js <specification.json>');
  if (!process.env.N8N_API_KEY || !process.env.N8N_BASE_URL) throw new Error('N8N_API_KEY and N8N_BASE_URL are required');
  const specification = JSON.parse(fs.readFileSync(path.resolve(specificationPath), 'utf8'));
  const workflow = compileDailyRssEmailDraft(specification);
  workflow.name = `__rss_email_draft_compiler_trial__${Date.now()}`;
  const createResponse = await fetch(`${process.env.N8N_BASE_URL}/api/v1/workflows`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': process.env.N8N_API_KEY, Connection: 'close' }, body: JSON.stringify(sanitizeCreateWorkflowPayload(workflow)) });
  if (!createResponse.ok) throw new Error(`n8n draft create failed: ${createResponse.status}`);
  const created = await createResponse.json();
  const readbackResponse = await fetch(`${process.env.N8N_BASE_URL}/api/v1/workflows/${encodeURIComponent(created.id)}`, { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY, Connection: 'close' } });
  if (!readbackResponse.ok) throw new Error(`n8n draft readback failed: ${readbackResponse.status}`);
  const readback = await readbackResponse.json();
  if (readback.name !== created.name || readback.nodes?.length !== workflow.nodes.length) throw new Error('n8n readback does not match created draft identity');
  process.stdout.write(`${JSON.stringify({ schemaVersion: '1.0', kind: 'daily_rss_email_draft_compiler_trial', executionPolicy: 'setup_required_before_execution', status: 'created_readback_verified', workflowId: created.id, workflowName: created.name, nodeCount: readback.nodes.length, requiredUserSetup: specification.requiredUserSetup, active: readback.active === true })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
