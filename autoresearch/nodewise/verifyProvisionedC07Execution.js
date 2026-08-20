'use strict';

const { extractFinalNodeItems } = require('../../chatbot/src/humanExecutionEvidenceRunner');
const { canonicalId, safeReport } = require('./verifyProvisionedExecution');
const { PREFIX } = require('./provisionC07CompilerWorkflow');

function verifyC07Execution(execution, workflowId, executionId) {
  if (!execution || canonicalId(execution.id) !== executionId || canonicalId(execution.workflowId) !== workflowId) {
    return safeReport({ workflowId, executionId, assertionStatus: 'skipped', itemCount: null, findingCategories: { identity: 1 } });
  }
  const items = extractFinalNodeItems(execution);
  if (!items || items.length !== 1) return safeReport({ workflowId, executionId, assertionStatus: 'fail', itemCount: items?.length ?? null, findingCategories: { output_shape: 1 } });
  const output = items[0].json;
  const valid = output && typeof output === 'object'
    && typeof output.name === 'string' && output.name.trim()
    && typeof output.email === 'string' && output.email.trim()
    && output.totalTodos === 20 && output.incompleteTodos === 9;
  return safeReport({ workflowId, executionId, assertionStatus: valid ? 'pass' : 'fail', itemCount: 1, findingCategories: valid ? {} : { output_contract: 1 } });
}

async function main({ fetchImpl = globalThis.fetch } = {}) {
  const workflowId = canonicalId(process.env.WORKFLOW_ID);
  const executionId = canonicalId(process.env.EXECUTION_ID);
  const baseUrl = String(process.env.N8N_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.N8N_API_KEY;
  if (!workflowId || !executionId || !baseUrl || !apiKey) throw new Error('WORKFLOW_ID, EXECUTION_ID, N8N_BASE_URL, and N8N_API_KEY are required');
  const headers = { 'X-N8N-API-KEY': apiKey };
  const workflowResponse = await fetchImpl(`${baseUrl}/api/v1/workflows/${encodeURIComponent(workflowId)}`, { headers });
  if (!workflowResponse.ok) throw new Error(`workflow_readback_failed_${workflowResponse.status}`);
  const workflow = await workflowResponse.json();
  if (String(workflow?.id) !== workflowId || !String(workflow?.name || '').startsWith(PREFIX)) throw new Error('workflow_identity_rejected');
  const executionResponse = await fetchImpl(`${baseUrl}/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`, { headers });
  if (!executionResponse.ok) throw new Error(`execution_readback_failed_${executionResponse.status}`);
  const report = verifyC07Execution(await executionResponse.json(), workflowId, executionId);
  report.kind = 'nodewise_c07_compiler_execution_evidence';
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { main, verifyC07Execution };
