'use strict';

const { validateSafeExecutionManifest } = require('./safeExecutionPolicy');
const { verifyFixtureExecutionOutput } = require('./executionVerificationRunner');

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalExactId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  return null;
}

function safeCaseId(manifest) {
  return typeof manifest?.caseId === 'string' && /^C\d{2}$/.test(manifest.caseId)
    ? manifest.caseId
    : null;
}

function findingCategoryCounts(findings) {
  const counts = {};
  for (const finding of Array.isArray(findings) ? findings : []) {
    const category = typeof finding?.category === 'string' && /^[a-z_]+$/.test(finding.category)
      ? finding.category
      : 'unknown';
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

function report(manifest, status, assertion) {
  const findings = Array.isArray(assertion?.findings) ? assertion.findings : [];
  return {
    caseId: safeCaseId(manifest),
    status,
    executionTrigger: 'human_ui',
    cleanup: { eligible: false },
    assertion: {
      findingCount: findings.length,
      findingCategories: findingCategoryCounts(findings),
    },
  };
}

/**
 * Reads only the standard final-node portion of an externally supplied n8n
 * execution. The node name and every execution value remain local variables
 * and are never returned in this module's report.
 */
function extractFinalNodeItems(execution) {
  if (!isPlainObject(execution)
    || !isPlainObject(execution.data)
    || !isPlainObject(execution.data.resultData)) return null;
  const { resultData } = execution.data;
  if (typeof resultData.lastNodeExecuted !== 'string' || !resultData.lastNodeExecuted
    || !isPlainObject(resultData.runData)
    || !own(resultData.runData, resultData.lastNodeExecuted)) return null;
  const nodeRuns = resultData.runData[resultData.lastNodeExecuted];
  if (!Array.isArray(nodeRuns) || !nodeRuns.length) return null;
  const finalRun = nodeRuns[nodeRuns.length - 1];
  const main = finalRun?.data?.main;
  if (!Array.isArray(main) || main.length !== 1 || !Array.isArray(main[0])) return null;
  if (main[0].some((item) => !isPlainObject(item) || !own(item, 'json'))) return null;
  return main[0];
}

/**
 * Pure orchestration boundary for evidence created by a human in the n8n UI.
 * `readExecution` receives only the exact execution ID. It must not list or
 * search executions. No execution data is persisted or included in the report.
 */
async function runHumanExecutionEvidence({ manifest, workflowId, executionId, readExecution } = {}) {
  if (manifest?.caseId !== 'C01' || validateSafeExecutionManifest(manifest).status !== 'pass') return report(manifest, 'skipped');
  const exactWorkflowId = canonicalExactId(workflowId);
  const exactExecutionId = canonicalExactId(executionId);
  if (!exactWorkflowId || !exactExecutionId || typeof readExecution !== 'function') {
    return report(manifest, 'skipped');
  }

  let execution;
  try {
    execution = await readExecution(exactExecutionId);
  } catch {
    return report(manifest, 'skipped');
  }
  if (!isPlainObject(execution)
    || canonicalExactId(execution.id) !== exactExecutionId
    || canonicalExactId(execution.workflowId) !== exactWorkflowId) {
    return report(manifest, 'skipped');
  }

  const executionOutput = extractFinalNodeItems(execution);
  if (!executionOutput) return report(manifest, 'skipped');

  const assertion = verifyFixtureExecutionOutput({ manifest, executionOutput });
  if (assertion.status === 'pass') return report(manifest, 'pass', assertion);
  if (assertion.status === 'fail') return report(manifest, 'fail', assertion);
  return report(manifest, 'skipped', assertion);
}

module.exports = { runHumanExecutionEvidence, extractFinalNodeItems };
