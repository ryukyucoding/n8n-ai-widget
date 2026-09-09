'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlannerAdapter, createSetupRequiredResolver } = require('./conversationDeps');

// ---- planner adapter: maps reviewNodewisePlannerResult envelopes -> controller contract ----
test('planner adapter maps a ready review envelope -> ready_to_compile + spec + message', async () => {
  const review = async () => ({ outcome: 'ready_to_compile', specification: { goal: 'read todos', steps: [{}, {}] }, plan: { goal: 'read todos', steps: [{}, {}] } });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'hi', previousSpec: null });
  assert.equal(r.outcome, 'ready_to_compile');
  assert.deepEqual(r.spec, { goal: 'read todos', steps: [{}, {}] });
  assert.match(r.assistantMessage, /read todos/);
});

test('planner adapter maps clarification -> clarification_required, no spec, asks for the inputs', async () => {
  const review = async () => ({ outcome: 'clarification_required', goal: 'do a thing', requiredUserInputs: ['which calendar', 'how many'] });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'x', previousSpec: null });
  assert.equal(r.outcome, 'clarification_required');
  assert.equal(r.spec, null);
  assert.match(r.assistantMessage, /which calendar/);
});

test('planner adapter maps unsupported -> unsupported_capability, no spec', async () => {
  const review = async () => ({ outcome: 'unsupported_capability', goal: 'g', capabilityGaps: ['transform.pivot'] });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'x', previousSpec: null });
  assert.equal(r.outcome, 'unsupported_capability');
  assert.equal(r.spec, null);
  assert.match(r.assistantMessage, /不支援|transform\.pivot/);
});

test('planner adapter forwards previousSpec to the review fn', async () => {
  const seen = [];
  const review = async (message, previousSpec) => { seen.push({ message, previousSpec }); return { outcome: 'clarification_required', goal: 'g', requiredUserInputs: ['x'] }; };
  const plan = createPlannerAdapter(review);
  await plan({ message: 'm', previousSpec: { goal: 'prev' } });
  assert.equal(seen[0].message, 'm');
  assert.deepEqual(seen[0].previousSpec, { goal: 'prev' });
});

// ---- setup_required credential resolver STUB (no n8n probe until API verified) ----
test('setup_required stub: no required credential types -> ready / bind_and_create', async () => {
  const resolve = createSetupRequiredResolver(() => []);
  const r = await resolve({ goal: 'public data' });
  assert.equal(r.overall, 'ready');
  assert.equal(r.createDisposition, 'bind_and_create');
  assert.deepEqual(r.requirements, []);
});

test('setup_required stub: required types -> setup_required / create_inactive_draft (never auto-ready)', async () => {
  const resolve = createSetupRequiredResolver(() => ['googleCalendarOAuth2Api']);
  const r = await resolve({ goal: 'read calendar' });
  assert.equal(r.overall, 'setup_required');
  assert.equal(r.createDisposition, 'create_inactive_draft');
  assert.equal(r.requirements[0].credentialType, 'googleCalendarOAuth2Api');
  assert.equal(r.requirements[0].status, 'setup_required');
});
