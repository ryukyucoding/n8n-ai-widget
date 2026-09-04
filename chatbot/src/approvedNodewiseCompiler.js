'use strict';

// The first product-path gateway for the guarded compiler. A nodewise
// specification is the canonical IR for this bounded capability set: the
// review is rendered from it, the approval is signed against it, and the
// compiler consumes that exact same value.

const crypto = require('node:crypto');
const runtimeSnapshot = require('../schemas/runtime_node_schemas.json');
const { SKILLS, resolveSkillRequirements } = require('./runtimeSkillRegistry');
const { schemaRevision } = require('./runtimeSchemaRevision');
const { sourceRegistryRevision } = require('./sourceSchemaRegistry');
const {
  stableStringify,
  computeFingerprint,
  issueApprovalToken,
  assertApprovedForCompilation,
} = require('./planBinding');
const { compileNodewiseSpecification, validateSpecification } = require('./nodewiseCompiler');
const { validatePlannerEnvelope } = require('./nodewisePlannerEnvelope');
const { diffPlans } = require('./planDiff');
const { buildCapabilityGapResponse } = require('./capabilityGap');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function skillRegistryRevision(skillRegistry = SKILLS) {
  return crypto.createHash('sha256').update(stableStringify(skillRegistry)).digest('hex');
}

function runtimeContext({ snapshot = runtimeSnapshot, skillRegistry = SKILLS, sourceRegistry } = {}) {
  return {
    runtimeSchemaRevision: schemaRevision(snapshot).revision,
    skillRegistryRevision: skillRegistryRevision(skillRegistry),
    sourceRegistryRevision: sourceRegistryRevision(sourceRegistry),
  };
}

function skillIdsForSpecification(specification) {
  const ids = [];
  for (const step of specification.steps) {
    if (step.capability === 'manual_trigger') ids.push('trigger.manual');
    if (step.capability === 'http_request') ids.push('http.public_get');
    if (step.capability === 'set_output') ids.push('output.one_object');
    if (step.capability === 'data_transform') {
      const operation = step.configuration?.operation;
      if (operation === 'select_fields') ids.push('transform.select_fields');
      if (operation === 'count_false_boolean') ids.push('transform.count_false_boolean');
      if (operation === 'join_object_and_count_false_boolean') ids.push('transform.join_object_and_count');
      if (operation === 'sort_items') ids.push('transform.sort_items');
      if (operation === 'remove_duplicates') ids.push('transform.remove_duplicates');
      if (operation === 'limit_items') ids.push('transform.limit_items');
    }
  }
  return [...new Set(ids)];
}

function nodewisePlanSummary(specification) {
  validateSpecification(specification);
  const externalDomains = [];
  const steps = specification.steps.map((step) => {
    const url = step.configuration?.url?.reference;
    if (typeof url === 'string') {
      const host = new URL(url).hostname;
      if (!externalDomains.includes(host)) externalDomains.push(host);
    }
    return { id: step.id, capability: step.capability, operation: step.configuration?.operation || null };
  });
  const requirements = resolveSkillRequirements(skillIdsForSpecification(specification));
  assert(requirements.available, `unsupported runtime skills: ${requirements.missing.join(', ')}`);
  return {
    goal: specification.goal.trim(),
    steps,
    expectedOutput: { ...specification.expectedOutput },
    externalDomains,
    setupRequirements: [
      ...requirements.credentialRequirements,
      ...requirements.configurationRequirements,
      ...(specification.requiredUserSetup || []),
    ],
    sideEffects: requirements.requiresConfirmation ? ['external_write'] : [],
  };
}

function proposeNodewisePlan(specification, options = {}) {
  const plan = nodewisePlanSummary(specification);
  const context = runtimeContext(options);
  return {
    plan,
    context,
    planFingerprint: computeFingerprint(specification, context),
  };
}

// planDiff is deliberately generic. This adapter exposes only stable semantic
// facts from the bounded nodewise specification, never generated n8n JSON.
function nodewiseSpecificationForDiff(specification) {
  validateSpecification(specification);
  return {
    goal: specification.goal,
    expectedOutput: specification.expectedOutput,
    steps: specification.steps.map((step) => ({
      id: step.id,
      kind: step.capability,
      dependsOn: [],
      inputShape: null,
      outputShape: step.configuration?.url?.cardinality || null,
      url: step.configuration?.url?.reference || null,
      operation: step.configuration?.operation || null,
      configuration: step.configuration || {},
    })),
  };
}

function diffNodewisePlans(previousSpecification, specification) {
  return diffPlans(
    nodewiseSpecificationForDiff(previousSpecification),
    nodewiseSpecificationForDiff(specification),
    { skillRegistry: SKILLS },
  );
}

function reviewNodewisePlannerResult(envelope, options = {}) {
  const plannerResult = validatePlannerEnvelope(envelope);
  if (plannerResult.outcome === 'clarification_required') return plannerResult;
  if (plannerResult.outcome === 'unsupported_capability') {
    return {
      ...plannerResult,
      capabilityGap: buildCapabilityGapResponse({
        userRequest: plannerResult.goal,
        requestedSkillIds: plannerResult.capabilityGaps,
        registry: options.skillRegistry || SKILLS,
      }),
    };
  }
  const review = proposeNodewisePlan(plannerResult.specification, options);
  return {
    ...plannerResult,
    ...review,
    planDiff: options.previousSpecification
      ? diffNodewisePlans(options.previousSpecification, plannerResult.specification)
      : null,
  };
}

function approveNodewisePlan(specification, { secret, sessionId, now, ttlSeconds, ...options } = {}) {
  // Rendering/validation before signing means invalid specifications never get a token.
  const review = proposeNodewisePlan(specification, options);
  return {
    ...review,
    approvalToken: issueApprovalToken(specification, review.context, { secret, sessionId, now, ttlSeconds }),
  };
}

function compileApprovedNodewisePlan(specification, approvalToken, { secret, sessionId, ...options } = {}) {
  nodewisePlanSummary(specification);
  const context = runtimeContext(options);
  const approval = assertApprovedForCompilation(approvalToken, specification, context, { secret, sessionId });
  return {
    workflow: compileNodewiseSpecification(specification),
    planFingerprint: approval.fingerprint,
    runtimeSchemaRevision: context.runtimeSchemaRevision,
    skillRegistryRevision: context.skillRegistryRevision,
  };
}

module.exports = {
  skillRegistryRevision,
  runtimeContext,
  skillIdsForSpecification,
  nodewisePlanSummary,
  proposeNodewisePlan,
  nodewiseSpecificationForDiff,
  diffNodewisePlans,
  reviewNodewisePlannerResult,
  approveNodewisePlan,
  compileApprovedNodewisePlan,
};
