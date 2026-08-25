'use strict';

const { verifyExecutionOutput } = require('./executionAssertion');
const { validateSafeExecutionManifest, verifyWorkflowReadback } = require('./safeExecutionPolicy');

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

function assertionReport(assertion) {
  const findings = Array.isArray(assertion?.findings) ? assertion.findings : [];
  return {
    findingCount: findings.length,
    findingCategories: findingCategoryCounts(findings),
  };
}

function report(manifest, status, cleanupEligible, assertion) {
  return {
    caseId: safeCaseId(manifest),
    status,
    cleanup: { eligible: cleanupEligible === true },
    assertion: assertionReport(assertion),
  };
}

function verifyFixtureExecutionOutput({ manifest, executionOutput } = {}) {
  return verifyExecutionOutput({
    executionOutput,
    acceptanceContract: { contractRevision: 1, executionAssertions: manifest?.executionAssertions },
    executionSafety: { allowed: true },
  });
}

function outputFromAdapter(adapterResult) {
  if (adapterResult && typeof adapterResult === 'object'
    && Object.prototype.hasOwnProperty.call(adapterResult, 'executionOutput')) {
    return adapterResult.executionOutput;
  }
  return adapterResult;
}

/**
 * This is an I/O-free orchestration boundary: both readback and execution are
 * caller-injected. It does not discover IDs or bind an n8n client/CLI. The
 * returned report deliberately excludes readback, output, workflow IDs, URLs,
 * prompts, and adapter errors.
 */
async function runExecutionVerification({ manifest, workflowId, readback, executionAdapter } = {}) {
  const policy = validateSafeExecutionManifest(manifest);
  if (policy.status !== 'pass') return report(manifest, 'skipped', false);
  if (typeof readback !== 'function' || typeof executionAdapter !== 'function') {
    return report(manifest, 'skipped', false);
  }

  let workflow;
  try {
    workflow = await readback(workflowId);
  } catch {
    return report(manifest, 'skipped', false);
  }
  const readbackPolicy = verifyWorkflowReadback({ workflow, workflowId, manifest });
  if (readbackPolicy.status !== 'pass') {
    return report(manifest, 'skipped', false);
  }

  let executionOutput;
  try {
    executionOutput = outputFromAdapter(await executionAdapter({ workflowId, manifest }));
  } catch {
    return report(manifest, 'fail', true);
  }

  const assertion = verifyFixtureExecutionOutput({ manifest, executionOutput });
  if (assertion.status === 'pass') return report(manifest, 'pass', true, assertion);
  if (assertion.status === 'fail') return report(manifest, 'fail', true, assertion);
  return report(manifest, 'skipped', true, assertion);
}

module.exports = { runExecutionVerification, verifyFixtureExecutionOutput };
