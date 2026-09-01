'use strict';

const crypto = require('node:crypto');

const REVIEW_STATES = Object.freeze({
  PROPOSED: 'proposed',
  REVISION_REQUESTED: 'revision_requested',
  APPROVED: 'approved',
  CANCELLED: 'cancelled',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fingerprint(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

// The review object contains a human-readable semantic plan only. It must not
// contain workflow JSON, credential values, or setup field values.
function proposePlanReview({ goal, summary, steps, expectedOutput, setupRequirements = [], revision = 1 }) {
  assert(typeof goal === 'string' && goal.trim(), 'goal is required');
  assert(typeof summary === 'string' && summary.trim(), 'summary is required');
  assert(Array.isArray(steps) && steps.length > 0, 'steps must be a non-empty array');
  assert(Array.isArray(expectedOutput), 'expectedOutput must be an array');
  assert(Array.isArray(setupRequirements), 'setupRequirements must be an array');
  assert(Number.isInteger(revision) && revision >= 1, 'revision must be a positive integer');

  const plan = {
    goal: goal.trim(),
    summary: summary.trim(),
    steps: steps.map((step, index) => {
      assert(typeof step === 'string' && step.trim(), `steps[${index}] must be a non-empty string`);
      return step.trim();
    }),
    expectedOutput: expectedOutput.map((field, index) => {
      assert(typeof field === 'string' && field.trim(), `expectedOutput[${index}] must be a non-empty string`);
      return field.trim();
    }),
    setupRequirements: setupRequirements.map((item, index) => {
      assert(typeof item === 'string' && item.trim(), `setupRequirements[${index}] must be a non-empty string`);
      return item.trim();
    }),
  };

  return { state: REVIEW_STATES.PROPOSED, revision, plan, planFingerprint: fingerprint(plan) };
}

function applyPlanReviewDecision(review, decision) {
  assert(review && review.state === REVIEW_STATES.PROPOSED, 'only a proposed plan can be reviewed');
  assert(decision && typeof decision === 'object', 'decision is required');

  if (decision.type === 'approve') {
    return { state: REVIEW_STATES.APPROVED, revision: review.revision, planFingerprint: review.planFingerprint };
  }
  if (decision.type === 'request_revision') {
    assert(typeof decision.instructions === 'string' && decision.instructions.trim(), 'revision instructions are required');
    return {
      state: REVIEW_STATES.REVISION_REQUESTED,
      revision: review.revision,
      priorPlanFingerprint: review.planFingerprint,
      revisionInstructions: decision.instructions.trim(),
    };
  }
  if (decision.type === 'cancel') {
    return { state: REVIEW_STATES.CANCELLED, revision: review.revision, planFingerprint: review.planFingerprint };
  }
  throw new Error('decision type is unsupported');
}

function canCompileApprovedPlan(review, approval) {
  return Boolean(
    review
    && approval
    && approval.state === REVIEW_STATES.APPROVED
    && approval.planFingerprint === review.planFingerprint,
  );
}

module.exports = { REVIEW_STATES, proposePlanReview, applyPlanReviewDecision, canCompileApprovedPlan };
