'use strict';

const REPAIR_POLICY = Object.freeze({
  maxLlmCandidates: 3,
  maxLlmRepairs: 2,
  maxGlobalDurationMs: 360000,
});

function createCandidateLimit(enabled, legacyMaxCandidates) {
  // The controller still treats the policy limit as the normal repair budget.
  // The one extra loop slot is reachable only when it explicitly authorizes a
  // terminal repair after the final normal candidate.
  return enabled ? REPAIR_POLICY.maxLlmCandidates + 1 : legacyMaxCandidates;
}

function safeFindingSummary(findings) {
  const counts = new Map();
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!finding || typeof finding !== 'object') continue;
    const record = {
      ruleId: typeof finding.ruleId === 'string' ? finding.ruleId : 'unknown',
      category: typeof finding.category === 'string' ? finding.category : 'unknown',
      severity: typeof finding.severity === 'string' ? finding.severity : 'unknown',
      repairable: finding.repairable === true,
      normalized: finding.normalized === true,
      locationKind: typeof finding.location?.kind === 'string' ? finding.location.kind : 'unknown',
    };
    const key = JSON.stringify(record);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ ...JSON.parse(key), count }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function buildCorrectnessFirstRepairPrompt({ contract, findings }) {
  const revision = contract?.contractRevision ?? 'unknown';
  return [
    'Correctness-first repair candidate required.',
    `Reuse acceptance contract revision ${revision}; do not change its business requirements or assume missing configuration.`,
    'Repair execution behavior and topology, not node display names, IDs, positions, or other UI metadata.',
    'For Code named references, the referenced producer must must-execute-before the Code node. Sibling fan-in into an any-input node is not a synchronization barrier.',
    'Use only the structured finding objectives below. Do not include credentials, tokens, workflow IDs, or secrets.',
    `Structured repair objectives: ${JSON.stringify(safeFindingSummary(findings))}`,
  ].join('\n');
}

function repairControllerLogPayload({ operation, report, timestamp }) {
  return {
    event: 'repair_controller_decision',
    operation,
    action: report?.repairDecision?.action || 'unknown',
    reason: report?.repairDecision?.reason || 'unknown',
    contractRevision: report?.contract?.contractRevision ?? null,
    findingStatistics: safeFindingSummary(report?.verification?.findings),
    repairBudget: report?.repairDecision?.budgetSummary || {},
    progress: report?.repairDecision?.progressSignals || {},
    candidateBehaviorFingerprint: report?.summary?.candidateBehaviorFingerprint || null,
    timestamp,
  };
}

/**
 * Evaluate the already-verified candidate for an optional repair candidate.
 * Exceptions are converted into a safe fallback result, never thrown into the
 * Create route. The caller keeps legacy retry behavior for that fallback.
 */
async function evaluateCorrectnessFirstRepair({ enabled, evaluateShadowRepair, operation, userRequest, plannerOutput, candidateWorkflow, verificationResult, existingContract, repairState, now = Date.now() } = {}) {
  if (!enabled) return { enabled: false, action: 'legacy' };
  try {
    const report = await evaluateShadowRepair({
      operation,
      userRequest,
      plannerOutput,
      candidateWorkflow,
      verificationResult,
      existingContract,
      repairState: { ...repairState, policy: REPAIR_POLICY },
      now,
    });
    return {
      enabled: true,
      action: report.repairDecision.action,
      report,
      repairPrompt: report.repairDecision.action === 'repair'
        ? buildCorrectnessFirstRepairPrompt({ contract: report.contract, findings: report.verification.findings })
        : null,
    };
  } catch (_) {
    return { enabled: true, action: 'fallback', reason: 'evaluation_failed' };
  }
}

/**
 * Shared Create retry adapter. The legacy branch deliberately does not call
 * the controller, so a disabled flag preserves its configured limit.
 */
async function decideCreateCandidateRetry({ correctnessFirstEnabled, attempt, legacyMaxCandidates, evaluateCorrectnessFirstRepair, controllerInput } = {}) {
  const candidateLimit = createCandidateLimit(correctnessFirstEnabled, legacyMaxCandidates);
  if (!correctnessFirstEnabled) {
    return {
      action: attempt + 1 < legacyMaxCandidates ? 'retry' : 'stop',
      candidateLimit,
      controller: null,
      repairPrompt: null,
    };
  }
  const controller = await evaluateCorrectnessFirstRepair({ enabled: true, ...controllerInput });
  if (controller.action === 'repair' && attempt + 1 < candidateLimit) {
    return { action: 'retry', candidateLimit, controller, repairPrompt: controller.repairPrompt };
  }
  // A controller failure must not crash Create. Fall back to the configured
  // legacy behavior, never to an unbounded repair loop.
  if (controller.action === 'fallback' && attempt + 1 < legacyMaxCandidates) {
    return { action: 'retry', candidateLimit, controller, repairPrompt: null };
  }
  return { action: 'stop', candidateLimit, controller, repairPrompt: null };
}

module.exports = {
  REPAIR_POLICY,
  createCandidateLimit,
  safeFindingSummary,
  buildCorrectnessFirstRepairPrompt,
  repairControllerLogPayload,
  evaluateCorrectnessFirstRepair,
  decideCreateCandidateRetry,
};
