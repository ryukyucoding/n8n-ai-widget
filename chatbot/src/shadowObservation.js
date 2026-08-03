'use strict';

function shadowRepairEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function findingStatistics(findings) {
  const counts = new Map();
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!finding || typeof finding !== 'object') continue;
    const ruleId = typeof finding.ruleId === 'string' ? finding.ruleId : 'unknown';
    const category = typeof finding.category === 'string' ? finding.category : 'unknown';
    const severity = typeof finding.severity === 'string' ? finding.severity : 'unknown';
    const key = JSON.stringify([ruleId, category, severity]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [ruleId, category, severity] = JSON.parse(key);
    return { ruleId, category, severity, count };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function shadowLogPayload({ operation, report, timestamp }) {
  return {
    event: 'shadow_repair_decision',
    operation,
    action: report?.repairDecision?.action || 'unknown',
    reason: report?.repairDecision?.reason || 'unknown',
    contractRevision: report?.contract?.contractRevision ?? null,
    findingStatistics: findingStatistics(report?.verification?.findings),
    repairBudget: report?.repairDecision?.budgetSummary || {},
    progress: report?.repairDecision?.progressSignals || {},
    candidateBehaviorFingerprint: report?.summary?.candidateBehaviorFingerprint || null,
    timestamp,
  };
}

/**
 * Best-effort boundary between Create and the shadow-only evaluator. It never
 * returns data to a caller that could alter Create's candidate, retries, n8n
 * requests, HTTP response, or stream contract.
 */
async function observeShadowRepair({ enabled, evaluateShadowRepair, logger = console, operation, userRequest, plannerOutput, candidateWorkflow, verificationResult, repairState, now = Date.now() } = {}) {
  if (!enabled) return { observed: false };
  try {
    const report = await evaluateShadowRepair({
      operation,
      userRequest,
      plannerOutput,
      candidateWorkflow,
      verificationResult,
      repairState,
      now,
    });
    logger.info('[chatbot] shadow_repair_decision', shadowLogPayload({ operation, report, timestamp: new Date(now).toISOString() }));
    return { observed: true, report };
  } catch (_) {
    // Deliberately do not log the thrown message: upstream input or an error
    // from a future adapter may contain sensitive workflow context.
    logger.warn('[chatbot] shadow_repair_warning', {
      event: 'shadow_repair_warning', operation, reason: 'evaluation_failed', timestamp: new Date(now).toISOString(),
    });
    return { observed: false, reason: 'evaluation_failed' };
  }
}

module.exports = { shadowRepairEnabled, findingStatistics, shadowLogPayload, observeShadowRepair };
