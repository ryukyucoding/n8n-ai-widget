'use strict';

/**
 * Phase 1 shadow-only repair controller.
 *
 * This module intentionally receives fingerprints and structured findings from
 * its caller. It does not inspect a workflow, invoke an LLM, or perform any
 * I/O. In particular, it never uses node names, IDs, positions, or topology
 * as a cycle key: `behaviorFingerprint` is the caller-owned identity for a
 * candidate's observable behavior.
 */

const DEFAULT_POLICY = Object.freeze({
  maxLlmCandidates: 3,
  maxLlmRepairs: 2,
  maxGlobalDurationMs: 360000,
  allowRepair: true,
});

const SEVERITY_RANK = Object.freeze({
  none: 0,
  info: 0,
  warning: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
});

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizePolicy(policy) {
  const supplied = policy && typeof policy === 'object' ? policy : {};
  return {
    maxLlmCandidates: Math.max(1, Math.floor(finiteNumber(supplied.maxLlmCandidates, DEFAULT_POLICY.maxLlmCandidates))),
    maxLlmRepairs: Math.max(0, Math.floor(finiteNumber(supplied.maxLlmRepairs, DEFAULT_POLICY.maxLlmRepairs))),
    maxGlobalDurationMs: Math.max(0, Math.floor(finiteNumber(supplied.maxGlobalDurationMs, DEFAULT_POLICY.maxGlobalDurationMs))),
    allowRepair: supplied.allowRepair !== false,
  };
}

function findingFingerprint(finding) {
  if (typeof finding === 'string') return finding.trim();
  if (!finding || typeof finding !== 'object') return '';
  for (const key of ['fingerprint', 'findingFingerprint', 'id', 'code']) {
    if (typeof finding[key] === 'string' && finding[key].trim()) return finding[key].trim();
  }
  return '';
}

function findingList(findingSet, candidate) {
  if (Array.isArray(findingSet)) return findingSet;
  if (findingSet && Array.isArray(findingSet.findings)) return findingSet.findings;
  if (candidate && Array.isArray(candidate.findings)) return candidate.findings;
  return [];
}

function isNormalizationWarning(finding) {
  if (!finding || typeof finding !== 'object') return false;
  const text = [finding.kind, finding.category, finding.code, finding.type]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return text.includes('normalization') || text.includes('normalisation') || text.includes('normalized')
    || text.includes('normalised');
}

function isBlockingExcluded(finding) {
  return Boolean(finding && typeof finding === 'object' && finding.blocking === false) || isNormalizationWarning(finding);
}

function isClarificationFinding(finding) {
  if (!finding || typeof finding !== 'object') return false;
  if (finding.action === 'clarify' || finding.severity === 'clarify' || finding.requiresClarification === true) return true;
  return [finding.kind, finding.category, finding.code, finding.type, finding.status]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes('clarif'));
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].sort();
}

function severityRank(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return SEVERITY_RANK[String(value || 'none').toLowerCase()] ?? SEVERITY_RANK.none;
}

function coverage(value) {
  const normalized = finiteNumber(value, 0);
  return Math.max(0, Math.min(1, normalized));
}

function historyCandidates(history) {
  return (Array.isArray(history) ? history : []).filter((entry) => entry && typeof entry === 'object'
    && (typeof entry.behaviorFingerprint === 'string' || typeof entry.candidateBehaviorFingerprint === 'string'));
}

function historyBehaviorFingerprint(entry) {
  return entry.behaviorFingerprint || entry.candidateBehaviorFingerprint || '';
}

function historyBlockingFingerprints(entry) {
  return sortedUnique(entry.blockingFindingFingerprints || entry.blockingFindings || []);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredClarificationCount(acceptanceContract) {
  const inputs = acceptanceContract && acceptanceContract.requiredUserInputs;
  return Array.isArray(inputs) ? inputs.filter(Boolean).length : 0;
}

function normalizeCandidate({ currentCandidate, findingSet, acceptanceContract }) {
  const candidate = currentCandidate && typeof currentCandidate === 'object' ? currentCandidate : {};
  const findings = findingList(findingSet, candidate);
  const findingByFingerprint = new Map(findings.map((finding) => [findingFingerprint(finding), finding]));
  const suppliedBlocking = sortedUnique(candidate.blockingFindingFingerprints || []);
  // Callers may supply an already-filtered list. When structured data is
  // available, filter any deterministic normalization warning defensively.
  const blockingFindingFingerprints = suppliedBlocking.filter((fingerprint) => !isBlockingExcluded(findingByFingerprint.get(fingerprint)));
  const normalizationWarnings = findings.filter(isNormalizationWarning);
  const clarificationFindingFingerprints = sortedUnique(findings
    .filter(isClarificationFinding)
    .map(findingFingerprint));
  const behaviorFingerprint = typeof candidate.behaviorFingerprint === 'string'
    ? candidate.behaviorFingerprint.trim()
    : '';

  return {
    behaviorFingerprint,
    blockingFindingFingerprints,
    clarificationFindingFingerprints,
    normalizationWarningCount: normalizationWarnings.length,
    findingCount: findings.length,
    severity: candidate.severity || 'none',
    severityRank: severityRank(candidate.severity),
    contractCoverage: coverage(candidate.contractCoverage),
    requiredClarificationCount: requiredClarificationCount(acceptanceContract),
    hasSafeRepairPath: candidate.hasSafeRepairPath !== false && candidate.safeRepairPath !== false,
  };
}

function budgetSummary(history, policy, elapsedMs) {
  const previousCandidates = historyCandidates(history).length;
  const llmCandidatesUsed = previousCandidates + 1; // current candidate is already generated
  const llmRepairsUsed = Math.max(0, llmCandidatesUsed - 1);
  const normalizedElapsedMs = Math.max(0, finiteNumber(elapsedMs, 0));
  return {
    elapsedMs: normalizedElapsedMs,
    maxGlobalDurationMs: policy.maxGlobalDurationMs,
    remainingGlobalDurationMs: Math.max(0, policy.maxGlobalDurationMs - normalizedElapsedMs),
    llmCandidatesUsed,
    maxLlmCandidates: policy.maxLlmCandidates,
    remainingLlmCandidates: Math.max(0, policy.maxLlmCandidates - llmCandidatesUsed),
    llmRepairsUsed,
    maxLlmRepairs: policy.maxLlmRepairs,
    remainingLlmRepairs: Math.max(0, policy.maxLlmRepairs - llmRepairsUsed),
    durationExhausted: normalizedElapsedMs >= policy.maxGlobalDurationMs,
    candidateBudgetExhausted: llmCandidatesUsed >= policy.maxLlmCandidates,
    repairBudgetExhausted: llmRepairsUsed >= policy.maxLlmRepairs,
  };
}

function progressSignals(candidate, history) {
  const previous = historyCandidates(history).at(-1);
  if (!previous) {
    return {
      comparedToPrevious: false,
      behaviorChanged: false,
      newBlockingFindingFingerprints: [...candidate.blockingFindingFingerprints],
      resolvedBlockingFindingFingerprints: [],
      severityDecreased: false,
      contractCoverageIncreased: false,
      progressDetected: false,
    };
  }
  const previousFindings = historyBlockingFingerprints(previous);
  const newBlockingFindingFingerprints = candidate.blockingFindingFingerprints.filter((value) => !previousFindings.includes(value));
  const resolvedBlockingFindingFingerprints = previousFindings.filter((value) => !candidate.blockingFindingFingerprints.includes(value));
  const severityDecreased = candidate.severityRank < severityRank(previous.severity);
  const contractCoverageIncreased = candidate.contractCoverage > coverage(previous.contractCoverage);
  return {
    comparedToPrevious: true,
    behaviorChanged: candidate.behaviorFingerprint !== historyBehaviorFingerprint(previous),
    newBlockingFindingFingerprints,
    resolvedBlockingFindingFingerprints,
    severityDecreased,
    contractCoverageIncreased,
    progressDetected: newBlockingFindingFingerprints.length > 0 || resolvedBlockingFindingFingerprints.length > 0
      || severityDecreased || contractCoverageIncreased,
  };
}

function redactedShadowEvent({ action, reason, candidate, budget, progress }) {
  return {
    shadowMode: true,
    controller: 'repair-controller-phase-1',
    action,
    reason,
    // Fingerprints are caller-provided opaque identifiers; messages, raw
    // workflows, node names, random IDs, and positions are never emitted.
    candidateBehaviorFingerprint: candidate.behaviorFingerprint || null,
    blockingFindingFingerprints: [...candidate.blockingFindingFingerprints],
    counts: {
      blockingFindings: candidate.blockingFindingFingerprints.length,
      clarificationFindings: candidate.clarificationFindingFingerprints.length,
      normalizationWarnings: candidate.normalizationWarningCount,
    },
    budget: {
      elapsedMs: budget.elapsedMs,
      llmCandidatesUsed: budget.llmCandidatesUsed,
      llmRepairsUsed: budget.llmRepairsUsed,
      durationExhausted: budget.durationExhausted,
      candidateBudgetExhausted: budget.candidateBudgetExhausted,
      repairBudgetExhausted: budget.repairBudgetExhausted,
    },
    progress: {
      behaviorChanged: progress.behaviorChanged,
      progressDetected: progress.progressDetected,
      newBlockingFindingCount: progress.newBlockingFindingFingerprints.length,
      resolvedBlockingFindingCount: progress.resolvedBlockingFindingFingerprints.length,
      severityDecreased: progress.severityDecreased,
      contractCoverageIncreased: progress.contractCoverageIncreased,
    },
  };
}

/**
 * Compute a future repair decision without changing any candidate or external
 * system. `history` must contain only earlier candidates; the current
 * candidate is counted once when calculating the LLM candidate/repair budget.
 */
function evaluateRepairDecision({ currentCandidate, findingSet, acceptanceContract, history = [], policy, elapsedMs } = {}) {
  const normalizedPolicy = normalizePolicy(policy);
  const candidate = normalizeCandidate({ currentCandidate, findingSet, acceptanceContract });
  const budget = budgetSummary(history, normalizedPolicy, elapsedMs);
  const previousCandidates = historyCandidates(history);
  const repeatedCandidateState = previousCandidates.some((entry) => (
    historyBehaviorFingerprint(entry) === candidate.behaviorFingerprint
    && sameStrings(historyBlockingFingerprints(entry), candidate.blockingFindingFingerprints)
  ));
  const progress = {
    ...progressSignals(candidate, history),
    repeatedCandidateState,
  };

  let action;
  let reason;
  if (candidate.clarificationFindingFingerprints.length || candidate.requiredClarificationCount) {
    action = 'clarify';
    reason = 'clarification_required';
  } else if (!candidate.blockingFindingFingerprints.length) {
    action = 'pass';
    reason = 'no_blocking_findings';
  } else if (repeatedCandidateState) {
    action = 'stop';
    reason = 'repeated_candidate_state';
  } else if (budget.durationExhausted) {
    action = 'stop';
    reason = 'global_duration_exhausted';
  } else if (budget.candidateBudgetExhausted || budget.repairBudgetExhausted) {
    action = 'stop';
    reason = 'repair_budget_exhausted';
  } else if (!normalizedPolicy.allowRepair || !candidate.hasSafeRepairPath) {
    action = 'stop';
    reason = 'no_safe_repair_path';
  } else {
    action = 'repair';
    reason = progress.progressDetected ? 'blocking_findings_with_progress' : 'blocking_findings_require_repair';
  }

  const normalizedMetadataSummary = {
    behaviorFingerprintPresent: Boolean(candidate.behaviorFingerprint),
    blockingFindingFingerprints: [...candidate.blockingFindingFingerprints],
    blockingFindingCount: candidate.blockingFindingFingerprints.length,
    clarificationFindingFingerprints: [...candidate.clarificationFindingFingerprints],
    clarificationFindingCount: candidate.clarificationFindingFingerprints.length,
    deterministicNormalizationWarningCount: candidate.normalizationWarningCount,
    findingCount: candidate.findingCount,
    severity: candidate.severity,
    severityRank: candidate.severityRank,
    contractCoverage: candidate.contractCoverage,
    requiredClarificationCount: candidate.requiredClarificationCount,
    hasSafeRepairPath: candidate.hasSafeRepairPath,
  };
  const shadowEvent = redactedShadowEvent({ action, reason, candidate, budget, progress });

  return { action, reason, normalizedMetadataSummary, budgetSummary: budget, progressSignals: progress, shadowEvent };
}

module.exports = { DEFAULT_POLICY, evaluateRepairDecision };
