'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { REVIEW_STATES, proposePlanReview, applyPlanReviewDecision, canCompileApprovedPlan } = require('./planReviewGate');

function plan() {
  return proposePlanReview({
    goal: 'Send a daily RSS digest.',
    summary: 'Read one public RSS feed and produce a daily digest.',
    steps: ['Read the feed', 'Filter recent entries', 'Format ten entries'],
    expectedOutput: ['markdown', 'count'],
    setupRequirements: ['SMTP credential'],
  });
}

test('requires explicit approval before a proposed plan can compile', () => {
  const review = plan();
  assert.equal(canCompileApprovedPlan(review, null), false);
  const approval = applyPlanReviewDecision(review, { type: 'approve' });
  assert.equal(approval.state, REVIEW_STATES.APPROVED);
  assert.equal(canCompileApprovedPlan(review, approval), true);
});

test('passes a natural-language correction back for replanning without compiling', () => {
  const result = applyPlanReviewDecision(plan(), { type: 'request_revision', instructions: 'Only include papers published in the last 12 hours.' });
  assert.equal(result.state, REVIEW_STATES.REVISION_REQUESTED);
  assert.match(result.revisionInstructions, /12 hours/);
});

test('does not let approval for an old plan unlock a revised plan', () => {
  const first = plan();
  const approval = applyPlanReviewDecision(first, { type: 'approve' });
  const revised = proposePlanReview({
    goal: first.plan.goal,
    summary: 'Read one public RSS feed and produce a shorter daily digest.',
    steps: ['Read the feed', 'Format five entries'],
    expectedOutput: ['markdown', 'count'],
    revision: 2,
  });
  assert.equal(canCompileApprovedPlan(revised, approval), false);
});
