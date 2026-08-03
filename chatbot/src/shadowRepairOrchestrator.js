'use strict';

const { createHash } = require('node:crypto');
const { normalizeAcceptanceContract, stableJson } = require('./acceptanceContract');
const { verifyCandidateWorkflow } = require('./candidateWorkflowVerifier');
const { evaluateRepairDecision } = require('./repairController');

const BLOCKING_SEVERITIES = new Set(['fatal', 'repair']);
const SEVERITY_RANK = Object.freeze({ warning: 1, clarify: 2, repair: 3, fatal: 4 });
const SECRET_KEY_PATTERN = /(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|oauth[_-]?secret|private[_-]?key|secret)/i;
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]+|pk_live_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+|bearer\s+[^\s]+)/ig;

function hash(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function identityStructuralValidator(input) {
  return input.candidateWorkflow;
}

function candidateObject(candidateWorkflow) {
  if (candidateWorkflow && typeof candidateWorkflow === 'object') return candidateWorkflow;
  if (typeof candidateWorkflow === 'string') {
    try { return JSON.parse(candidateWorkflow); } catch (_) { return null; }
  }
  return null;
}

function executionParameters(node) {
  return node && typeof node.parameters === 'object' && node.parameters !== null ? node.parameters : {};
}

function nodeDescriptor(node) {
  return {
    type: typeof node?.type === 'string' ? node.type : null,
    typeVersion: node?.typeVersion ?? null,
    parameters: executionParameters(node),
    disabled: node?.disabled === true,
    continueOnFail: node?.continueOnFail === true,
    alwaysOutputData: node?.alwaysOutputData === true,
    executeOnce: node?.executeOnce === true,
    onError: node?.onError ?? null,
    retryOnFail: node?.retryOnFail === true,
    maxTries: node?.maxTries ?? null,
    waitBetweenTries: node?.waitBetweenTries ?? null,
  };
}

function workflowEdges(workflow) {
  const edges = [];
  for (const [sourceName, outputTypes] of Object.entries(workflow?.connections || {})) {
    for (const [connectionType, groups] of Object.entries(outputTypes || {})) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((group, outputIndex) => {
        if (!Array.isArray(group)) return;
        group.forEach((connection) => {
          if (connection && typeof connection.node === 'string') {
            edges.push({ sourceName, targetName: connection.node, connectionType, outputIndex, inputIndex: Number.isInteger(connection.index) ? connection.index : 0 });
          }
        });
      });
    }
  }
  return edges;
}

function canonicalWorkflowBehavior(candidateWorkflow, contract) {
  const workflow = candidateObject(candidateWorkflow);
  if (!workflow || !Array.isArray(workflow.nodes)) return { fingerprint: hash({ invalidCandidate: true }), nodeRoles: new Map() };
  const nodes = workflow.nodes.filter((node) => node && typeof node === 'object' && typeof node.name === 'string');
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const edges = workflowEdges(workflow).filter((edge) => byName.has(edge.sourceName) && byName.has(edge.targetName));
  const descriptors = new Map(nodes.map((node) => [node.name, nodeDescriptor(node)]));
  let labels = new Map(nodes.map((node) => [node.name, hash(descriptors.get(node.name))]));
  // Refinement uses only graph relations and execution descriptors. Names are
  // lookup handles for connections, never part of a label or fingerprint.
  for (let iteration = 0; iteration < Math.max(1, nodes.length); iteration += 1) {
    const next = new Map();
    for (const node of nodes) {
      const incoming = edges.filter((edge) => edge.targetName === node.name)
        .map((edge) => ({ from: labels.get(edge.sourceName), type: edge.connectionType, output: edge.outputIndex, input: edge.inputIndex }))
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      const outgoing = edges.filter((edge) => edge.sourceName === node.name)
        .map((edge) => ({ to: labels.get(edge.targetName), type: edge.connectionType, output: edge.outputIndex, input: edge.inputIndex }))
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      next.set(node.name, hash({ descriptor: descriptors.get(node.name), incoming, outgoing }));
    }
    if (nodes.every((node) => labels.get(node.name) === next.get(node.name))) break;
    labels = next;
  }
  const roleMapping = candidateWorkflow?.contractRoleMapping || candidateWorkflow?.metadata?.contractRoleMapping || {};
  const contractRoles = Object.entries(roleMapping)
    .filter(([nodeName]) => byName.has(nodeName))
    .map(([nodeName, contractRole]) => ({ nodeRole: labels.get(nodeName), contractRole }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const canonicalNodes = nodes.map((node) => ({ role: labels.get(node.name), descriptor: descriptors.get(node.name) }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const canonicalEdges = edges.map((edge) => ({
    from: labels.get(edge.sourceName), to: labels.get(edge.targetName), type: edge.connectionType, output: edge.outputIndex, input: edge.inputIndex,
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return {
    fingerprint: hash({ topology: { nodes: canonicalNodes, edges: canonicalEdges }, contractRoles, contractVersion: contract?.contractVersion, contractRevision: contract?.contractRevision }),
    nodeRoles: labels,
  };
}

function normalizedFindingLocation(location, nodeRoles) {
  const source = location && typeof location === 'object' ? location : {};
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'codeNodeName' || key === 'sourceNodeName') normalized[`${key}Role`] = nodeRoles.get(value) || null;
    else if (key === 'referencedNodeName' || key === 'targetNodeName') normalized[`${key}Role`] = nodeRoles.get(value) || null;
    else normalized[key] = value;
  }
  return normalized;
}

function structuredFindingSummary(findings, behavior) {
  const structured = Array.isArray(findings) ? findings.filter((finding) => finding && typeof finding === 'object') : [];
  const blocking = structured.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity) && finding.normalized !== true);
  const blockingFindingFingerprints = [...new Set(blocking.map((finding) => hash({
    ruleId: finding.ruleId,
    severity: finding.severity,
    evidenceSource: finding.evidenceSource,
    category: finding.category,
    location: normalizedFindingLocation(finding.location, behavior.nodeRoles),
    repairable: finding.repairable === true,
    normalized: finding.normalized === true,
  })))].sort();
  const highest = structured.reduce((current, finding) => Math.max(current, SEVERITY_RANK[finding.severity] || 0), 0);
  const severity = highest >= 4 ? 'critical' : highest >= 3 ? 'high' : highest >= 2 ? 'medium' : highest ? 'low' : 'none';
  const repairableCount = blocking.filter((finding) => finding.repairable === true).length;
  const assertionCount = Math.max(1,
    (Array.isArray(behavior.contract?.requiredCapabilities) ? behavior.contract.requiredCapabilities.length : 0)
    + (Array.isArray(behavior.contract?.outputAssertions) ? behavior.contract.outputAssertions.length : 0)
    + (Array.isArray(behavior.contract?.dataflowAssertions) ? behavior.contract.dataflowAssertions.length : 0));
  return {
    blockingFindingFingerprints,
    severity,
    repairableCount,
    nonRepairableBlockingCount: blocking.length - repairableCount,
    normalizedWarningCount: structured.filter((finding) => finding.normalized === true).length,
    contractCoverage: Math.max(0, (assertionCount - blocking.length) / assertionCount),
  };
}

function redactForReport(value, key = '') {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactForReport(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactForReport(nestedValue, nestedKey)]));
  if (typeof value === 'string') return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  return value;
}

function elapsedMs(repairState, now) {
  if (typeof repairState?.elapsedMs === 'number') return repairState.elapsedMs;
  if (typeof repairState?.startedAt === 'number' && typeof now === 'number') return Math.max(0, now - repairState.startedAt);
  return 0;
}

/**
 * Shadow-only orchestration. It creates no retries and modifies no input. A
 * caller-provided structural validator and runtime schema map must themselves
 * be pure data/pure functions; semantic review is intentionally never passed
 * through, so this orchestrator cannot make an LLM call.
 */
async function evaluateShadowRepair({ operation, userRequest, plannerOutput, candidateWorkflow, existingContract, userClarification, verifierOptions = {}, verificationResult, repairState = {}, now } = {}) {
  const deliveryMode = plannerOutput?.deliveryMode || plannerOutput?.delivery_mode || 'candidate-only';
  const contract = normalizeAcceptanceContract({
    userRequest,
    plannerResult: plannerOutput,
    deliveryMode,
    existingContract,
    userClarification,
  });
  const verification = verificationResult || await verifyCandidateWorkflow({ operation, userRequest, candidateWorkflow, acceptanceContract: contract }, {
    structuralValidator: typeof verifierOptions.structuralValidator === 'function' ? verifierOptions.structuralValidator : identityStructuralValidator,
    runtimeSchemas: Object.prototype.hasOwnProperty.call(verifierOptions, 'runtimeSchemas') ? verifierOptions.runtimeSchemas : {},
  });
  const behavior = canonicalWorkflowBehavior(verification.workflow || candidateWorkflow, contract);
  behavior.contract = contract;
  const findingSummary = structuredFindingSummary(verification.findings, behavior);
  const repairDecision = evaluateRepairDecision({
    currentCandidate: {
      behaviorFingerprint: behavior.fingerprint,
      blockingFindingFingerprints: findingSummary.blockingFindingFingerprints,
      severity: findingSummary.severity,
      contractCoverage: findingSummary.contractCoverage,
      hasSafeRepairPath: findingSummary.nonRepairableBlockingCount === 0,
    },
    findingSet: { findings: verification.findings },
    acceptanceContract: contract,
    history: Array.isArray(repairState.history) ? repairState.history : [],
    policy: repairState.policy,
    elapsedMs: elapsedMs(repairState, now),
  });
  const report = {
    contract,
    verification,
    repairDecision,
    summary: {
      candidateBehaviorFingerprint: behavior.fingerprint,
      blockingFindingFingerprints: findingSummary.blockingFindingFingerprints,
      severity: findingSummary.severity,
      contractCoverage: findingSummary.contractCoverage,
      repairableFindingCount: findingSummary.repairableCount,
      nonRepairableBlockingFindingCount: findingSummary.nonRepairableBlockingCount,
      normalizedWarningCount: findingSummary.normalizedWarningCount,
    },
    shadowEvent: repairDecision.shadowEvent,
  };
  return redactForReport(report);
}

module.exports = { evaluateShadowRepair, canonicalWorkflowBehavior, structuredFindingSummary };
