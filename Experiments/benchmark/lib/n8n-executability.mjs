/**
 * Import pred → execute → optional repair loop for creation benchmark.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWorkflow,
  deleteWorkflow,
  stripWorkflowForImport,
  updateWorkflow,
} from './n8n-api.mjs';
import { callRepairPred } from './repair-pred.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  classifyRepairError,
  executeWorkflowAndCollectError,
  extractExecutionError,
} = require(resolve(__dirname, '../../../chatbot/src/n8nExecution.js'));

const STOP_CATEGORIES = new Set(['credential', 'external_api', 'api_trigger']);

function classifyExecError(errorContext) {
  if (!errorContext || typeof errorContext !== 'object') return 'unknown';
  const blob = `${errorContext.message || ''} ${errorContext.stack || ''}`.toLowerCase();
  if (
    /\bcredentials?\b/.test(blob) ||
    /missing credentials?/.test(blob) ||
    /credentials? are not (set|configured)/.test(blob) ||
    /connect your .{0,40} account/.test(blob)
  ) {
    return 'credential';
  }
  return classifyRepairError(errorContext);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      const code = err?.cause?.code || '';
      const msg = String(err?.message || '').toLowerCase();
      const retryable =
        msg.includes('fetch failed') ||
        code === 'ECONNRESET' ||
        code === 'UND_ERR_SOCKET';
      if (i >= retries || !retryable) throw err;
      await sleep(120 * (i + 1));
    }
  }
  throw lastErr;
}

/** Local benchmark: docker-compose hostname n8n:5678 → localhost. */
export function resolveN8nBaseUrl() {
  const raw =
    process.env.BENCHMARK_N8N_BASE_URL ||
    process.env.N8N_BASE_URL ||
    'http://localhost:5678';
  if (/n8n:5678/.test(raw)) return 'http://localhost:5678';
  return raw.replace(/\/$/, '');
}

function errorSignature(errorContext) {
  if (!errorContext || typeof errorContext !== 'object') return '';
  const node = String(errorContext.node || '').trim();
  const msg = String(errorContext.message || '').trim().slice(0, 200);
  return `${node}::${msg}`;
}

function summarizeExecResult(result) {
  const status = result?.status || 'unknown';
  const err = result?.errorContext || null;
  const category = err ? classifyExecError(err) : null;
  return {
    status,
    execute_success: status === 'success',
    error_context: err,
    error_category: category,
    failed_node: err?.node || null,
    error_message: err?.message || null,
    trigger_method: result?.trigger?.method || null,
  };
}

async function runExecuteProbe({ workflowId, workflow, baseUrl, apiKey, startedAfterMs }) {
  return executeWorkflowAndCollectError({
    workflowId,
    workflow,
    baseUrl,
    apiKey,
    fetchWithRetry,
    startedAfterMs,
  });
}

/**
 * Measure whether a pred workflow can be imported and executed in n8n.
 * Optional repair loop uses repair_runner (deterministic + modify LLM patch).
 */
export async function measureExecutability({
  workflow,
  caseId = 'bench-case',
  baseUrl = resolveN8nBaseUrl(),
  apiKey = process.env.N8N_API_KEY || '',
  repair = false,
  maxRepairIterations = Number(process.env.BENCH_MAX_REPAIR_ITERATIONS || 2),
  instruction = '',
  model = process.env.OPENAI_MODEL || 'gpt-4o',
  openaiApiKey = process.env.OPENAI_API_KEY || '',
  validationIssues = null,
}) {
  const started = Date.now();
  const out = {
    caseId,
    baseUrl,
    import_ok: false,
    execute_status: 'skipped',
    execute_success: false,
    error_category: null,
    failed_node: null,
    error_message: null,
    repair_enabled: repair,
    repair_attempts: [],
    repair_success: false,
    final_execute_success: false,
    final_execute_status: 'skipped',
    elapsedMs: 0,
  };

  if (!apiKey) {
    out.error_message = 'N8N_API_KEY missing';
    out.elapsedMs = Date.now() - started;
    return out;
  }

  let workflowId = null;
  let liveWorkflow = null;

  try {
    const doc = stripWorkflowForImport(workflow, `bench-exec-${caseId}`);
    const created = await createWorkflow(baseUrl, apiKey, doc);
    workflowId = created.id;
    liveWorkflow = created;
    out.import_ok = true;
    out.workflow_id = workflowId;

    let probe = await runExecuteProbe({
      workflowId,
      workflow: liveWorkflow,
      baseUrl,
      apiKey,
      startedAfterMs: Date.now() - 3000,
    });
    let summary = summarizeExecResult(probe);
    out.execute_status = summary.status;
    out.execute_success = summary.execute_success;
    out.error_category = summary.error_category;
    out.failed_node = summary.failed_node;
    out.error_message = summary.error_message;
    out.trigger_method = summary.trigger_method;
    out.trigger_ok = summary.status !== 'trigger_failed';
    out.credential_blocked =
      !summary.execute_success && summary.error_category === 'credential';
    out.runtime_reached =
      summary.execute_success ||
      (out.trigger_ok &&
        summary.status === 'error' &&
        summary.error_category === 'credential') ||
      (summary.status === 'error' &&
        summary.error_category &&
        !['external_api', 'api_trigger'].includes(summary.error_category));

    if (summary.execute_success) {
      out.final_execute_success = true;
      out.final_execute_status = 'success';
      out.elapsedMs = Date.now() - started;
      return out;
    }

    if (!repair || !probe.errorContext) {
      out.final_execute_status = summary.status;
      out.final_execute_success = summary.execute_success;
      out.elapsedMs = Date.now() - started;
      return out;
    }

    const priorSigs = [];
    let currentError = probe.errorContext;

    for (let i = 1; i <= maxRepairIterations; i += 1) {
      const category = classifyExecError(currentError);
      const attempt = {
        iteration: i,
        error_category: category,
        failed_node: currentError?.node || null,
        error_message: currentError?.message || null,
      };

      if (STOP_CATEGORIES.has(category)) {
        attempt.stopped = 'non_auto_fixable';
        out.repair_attempts.push(attempt);
        break;
      }

      const repairResult = callRepairPred({
        workflow: liveWorkflow,
        errorContext: currentError,
        validationIssues,
        instruction,
        priorSignatures: priorSigs,
        iteration: i,
        model,
        apiKey: openaiApiKey,
      });

      attempt.repair_ok = !!repairResult.ok;
      attempt.llm_applied = !!repairResult.llm_applied;
      attempt.needs_user_action = !!repairResult.needs_user_action;
      attempt.repair_category = repairResult.category || category;
      attempt.deterministic_fixes = repairResult.deterministic_fixes || [];

      if (repairResult.needs_user_action) {
        attempt.stopped = 'needs_user_action';
        out.repair_attempts.push(attempt);
        break;
      }

      const modified = repairResult.modified_workflow;
      if (!modified?.nodes?.length) {
        attempt.stopped = 'no_modified_workflow';
        out.repair_attempts.push(attempt);
        break;
      }

      const updated = await updateWorkflow(baseUrl, apiKey, workflowId, {
        ...stripWorkflowForImport(modified, liveWorkflow.name || doc.name),
        id: workflowId,
      });
      liveWorkflow = updated;
      priorSigs.push(errorSignature(currentError));

      await sleep(800);
      probe = await runExecuteProbe({
        workflowId,
        workflow: liveWorkflow,
        baseUrl,
        apiKey,
        startedAfterMs: Date.now() - 2000,
      });
      summary = summarizeExecResult(probe);
      attempt.post_execute_status = summary.status;
      attempt.post_execute_success = summary.execute_success;
      out.repair_attempts.push(attempt);

      if (summary.execute_success) {
        out.repair_success = true;
        out.final_execute_success = true;
        out.final_execute_status = 'success';
        out.execute_status = summary.status;
        out.execute_success = true;
        out.error_category = null;
        out.failed_node = null;
        out.error_message = null;
        break;
      }

      currentError = probe.errorContext;
      if (!currentError) break;
      out.final_execute_status = summary.status;
      out.error_category = summary.error_category;
      out.failed_node = summary.failed_node;
      out.error_message = summary.error_message;
    }

    if (!out.final_execute_success) {
      out.final_execute_status = out.execute_status || 'error';
    }
  } catch (err) {
    out.error_message = err.message || String(err);
    if (!out.import_ok) out.execute_status = 'import_failed';
  } finally {
    if (workflowId) {
      await deleteWorkflow(baseUrl, apiKey, workflowId).catch(() => {});
    }
    out.elapsedMs = Date.now() - started;
  }

  return out;
}

export { classifyRepairError, extractExecutionError };
