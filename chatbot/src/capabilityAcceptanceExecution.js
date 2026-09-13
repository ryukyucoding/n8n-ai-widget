'use strict';

// Fixed execution adapter built on the verified phase-2 path:
// create throwaway webhook variant -> activate -> POST webhook -> poll the
// exact workflow execution -> read includeData runData -> sanitize facts ->
// deactivate/delete variant. It accepts only the four fixed fixture IDs.

const { FIXTURE_IDS } = require('./capabilityAcceptanceBackend');

const TRIGGER_MODES = Object.freeze({
  schedule_todo_summary: 'webhook_harness_dataflow_verified',
  slice_todo_page: 'webhook_harness_dataflow_verified',
  set_fields_user: 'webhook_harness_dataflow_verified',
  set_fields_numeric: 'webhook_harness_dataflow_verified',
  current_date: 'webhook_harness_dataflow_verified',
});

function assert(condition, message) { if (!condition) throw new Error(message); }
function validId(id) { return (typeof id === 'string' || typeof id === 'number') && /^[A-Za-z0-9_-]{1,128}$/.test(String(id)); }
function items(runData, name) {
  const runs = runData && runData[name];
  assert(Array.isArray(runs) && runs.length, `missing runData for fixed node ${name}`);
  const output = runs[0] && runs[0].data && runs[0].data.main && runs[0].data.main[0];
  assert(Array.isArray(output), `missing main output for fixed node ${name}`);
  return output.map((item) => item && item.json || {});
}

function transformTrigger(workflow, fixtureId) {
  const copy = JSON.parse(JSON.stringify(workflow));
  const triggers = copy.nodes.filter((node) => node.type === 'n8n-nodes-base.manualTrigger' || node.type === 'n8n-nodes-base.scheduleTrigger');
  assert(triggers.length === 1, 'fixed fixture must have exactly one trigger');
  const trigger = triggers[0];
  const path = `capability-acceptance-${fixtureId}`;
  trigger.type = 'n8n-nodes-base.webhook';
  trigger.typeVersion = 2.1;
  trigger.parameters = { httpMethod: 'POST', path, responseMode: 'onReceived', options: {} };
  trigger.webhookId = path;
  return { workflow: copy, path };
}

function finishedExecution(executions, workflowId, sinceMs) {
  const candidates = (executions && executions.data || []).filter((entry) => {
    if (!entry || entry.finished !== true || String(entry.workflowId) !== String(workflowId)) return false;
    const started = Date.parse(entry.startedAt || '');
    return Number.isFinite(started) && started >= sinceMs - 5000 && validId(entry.id);
  }).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return candidates[0] || null;
}

function extractFacts(fixtureId, runData) {
  const finalName = fixtureId === 'schedule_todo_summary' ? 'Step 4: output'
    : fixtureId === 'slice_todo_page' ? 'Step 5: output'
      : (fixtureId === 'set_fields_user' || fixtureId === 'set_fields_numeric') ? 'Step 3: mapped' : 'Step 2: today';
  const final = items(runData, finalName)[0] || {};
  if (fixtureId === 'schedule_todo_summary' || fixtureId === 'slice_todo_page') {
    const pageName = fixtureId === 'slice_todo_page' ? 'Step 3: page' : null;
    const page = pageName ? items(runData, pageName) : [];
    return { executed: true, totalTodos: final.totalTodos, incompleteTodos: final.incompleteTodos, retainedIds: page.map((item) => item.id) };
  }
  if (fixtureId === 'set_fields_user') return { executed: true, name: final.name, status: final.status, isActive: final.isActive };
  if (fixtureId === 'set_fields_numeric') return { executed: true, name: final.name, rank: final.rank };
  return { executed: true, currentDate: final.currentDate };
}

function createFixedWebhookExecutionAdapter({
  n8n,
  publicBaseUrl,
  pollTimeoutMs = 120000,
  pollIntervalMs = 1000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const methods = ['getWorkflow', 'createWorkflow', 'activateWorkflow', 'triggerWebhook', 'listExecutions', 'getExecution', 'deactivateWorkflow', 'deleteWorkflow'];
  assert(n8n && methods.every((method) => typeof n8n[method] === 'function'), 'fixed webhook execution API is incomplete');
  assert(typeof publicBaseUrl === 'string' && /^https?:\/\/[^/?#]+$/i.test(publicBaseUrl), 'public webhook base URL is invalid');

  async function executeWorkflow(workflowId, fixtureId) {
    assert(FIXTURE_IDS.includes(fixtureId), 'fixture is not in the fixed acceptance allowlist');
    assert(validId(workflowId), 'workflow id is not usable');
    const original = await n8n.getWorkflow(workflowId);
    const variant = transformTrigger(original, fixtureId);
    const created = await n8n.createWorkflow(variant.workflow);
    const variantId = created && created.id;
    assert(validId(variantId), 'webhook variant returned no usable id');
    const startedAt = now();
    try {
      await n8n.activateWorkflow(variantId);
      const triggerStatus = await n8n.triggerWebhook(variant.path, publicBaseUrl);
      assert(triggerStatus >= 200 && triggerStatus < 300, 'fixed webhook trigger did not return 2xx');
      const deadline = now() + pollTimeoutMs;
      let execution = null;
      while (now() <= deadline && !execution) {
        execution = finishedExecution(await n8n.listExecutions(variantId), variantId, startedAt);
        if (!execution) await sleep(pollIntervalMs);
      }
      assert(execution, 'no exact finished execution found for fixed webhook variant');
      const full = await n8n.getExecution(execution.id);
      const runData = full && full.data && full.data.resultData && full.data.resultData.runData;
      assert(runData && typeof runData === 'object', 'execution returned no runData');
      return { ...extractFacts(fixtureId, runData), executionStatus: TRIGGER_MODES[fixtureId] };
    } finally {
      try { await n8n.deactivateWorkflow(variantId); } catch (_) { /* delete still attempted */ }
      await n8n.deleteWorkflow(variantId);
    }
  }

  return { executeWorkflow, triggerModes: TRIGGER_MODES };
}

module.exports = { TRIGGER_MODES, transformTrigger, finishedExecution, extractFacts, createFixedWebhookExecutionAdapter };
