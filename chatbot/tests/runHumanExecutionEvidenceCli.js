'use strict';

const C01 = require('./createFixtures/C01.json');
const { runHumanExecutionEvidence } = require('../src/humanExecutionEvidenceRunner');

function canonicalExactId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  return null;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) return null;
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--workflowId', '--executionId'].includes(flag)
      || Object.prototype.hasOwnProperty.call(values, flag)
      || typeof value !== 'string') return null;
    values[flag] = value;
  }
  const workflowId = canonicalExactId(values['--workflowId']);
  const executionId = canonicalExactId(values['--executionId']);
  return workflowId && executionId ? { workflowId, executionId } : null;
}

function exactExecutionPath(executionId) {
  const exactExecutionId = canonicalExactId(executionId);
  if (!exactExecutionId) return null;
  return `/api/v1/executions/${encodeURIComponent(exactExecutionId)}?includeData=true`;
}

function createExactExecutionReader({ workflowId, requestExactExecution } = {}) {
  const exactWorkflowId = canonicalExactId(workflowId);
  if (!exactWorkflowId || typeof requestExactExecution !== 'function') return null;
  return async (executionId) => {
    const exactExecutionId = canonicalExactId(executionId);
    if (!exactExecutionId) throw new Error('exact_execution_id_required');
    const response = await requestExactExecution(exactExecutionId);
    if (!isPlainObject(response) || response.status !== 200 || !isPlainObject(response.execution)) {
      throw new Error('exact_execution_read_unavailable');
    }
    const execution = response.execution;
    if (canonicalExactId(execution.id) !== exactExecutionId
      || canonicalExactId(execution.workflowId) !== exactWorkflowId
      || execution.finished !== true
      || execution.status !== 'success') {
      throw new Error('exact_execution_identity_or_completion_unverified');
    }
    return execution;
  };
}

/**
 * The only production transport. It obtains the API key at invocation time
 * from the process environment, issues one exact-ID GET, and never logs or
 * writes the response. Tests inject `requestExactExecution` instead.
 */
function createPublicApiExactExecutionReader({ workflowId, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  return createExactExecutionReader({
    workflowId,
    requestExactExecution: async (executionId) => {
      const baseUrl = process.env.N8N_BASE_URL;
      const apiKey = process.env.N8N_API_KEY;
      const path = exactExecutionPath(executionId);
      if (typeof baseUrl !== 'string' || !baseUrl || typeof apiKey !== 'string' || !apiKey || !path) {
        throw new Error('runtime_configuration_unavailable');
      }
      let endpoint;
      try {
        const base = new URL(baseUrl);
        if (!['http:', 'https:'].includes(base.protocol)) throw new Error('invalid_base_url');
        endpoint = new URL(path, base.origin).toString();
      } catch {
        throw new Error('runtime_configuration_unavailable');
      }
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-N8N-API-KEY': apiKey,
          },
        });
      } catch {
        throw new Error('exact_execution_read_unavailable');
      }
      if (!response || response.status !== 200 || typeof response.json !== 'function') {
        throw new Error('exact_execution_read_unavailable');
      }
      let execution;
      try {
        execution = await response.json();
      } catch {
        throw new Error('exact_execution_read_unavailable');
      }
      return { status: response.status, execution };
    },
  });
}

function skippedReport() {
  return {
    caseId: 'C01',
    status: 'skipped',
    executionTrigger: 'human_ui',
    cleanup: { eligible: false },
    assertion: { findingCount: 0, findingCategories: {} },
  };
}

async function runCli({ argv, readExecution, createReader = createPublicApiExactExecutionReader } = {}) {
  const args = parseCliArgs(argv);
  if (!args) return skippedReport();
  const reader = readExecution || createReader({ workflowId: args.workflowId });
  return runHumanExecutionEvidence({
    manifest: C01,
    workflowId: args.workflowId,
    executionId: args.executionId,
    readExecution: reader,
  });
}

function writeReport(report, write = process.stdout.write.bind(process.stdout)) {
  write(`${JSON.stringify(report)}\n`);
}

async function main() {
  let report;
  try {
    report = await runCli({ argv: process.argv.slice(2) });
  } catch {
    report = skippedReport();
  }
  writeReport(report);
}

if (require.main === module) {
  void main();
}

module.exports = {
  createExactExecutionReader,
  createPublicApiExactExecutionReader,
  exactExecutionPath,
  parseCliArgs,
  runCli,
  skippedReport,
  writeReport,
};
