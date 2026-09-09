'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactForPlannerContext, assertPlannerContextClean } = require('./plannerContextRedaction');

test('planner context keeps only plan spec + credential requirement type/status', () => {
  const ctx = redactForPlannerContext({
    planSpec: { goal: 'read calendar', steps: [{ capability: 'manual_trigger' }] },
    credentialRequirements: [
      { credentialType: 'googleCalendarOAuth2Api', status: 'ready', boundName: 'My Cal', handle: 'h1', id: 'REAL', token: 'secret' },
    ],
    // everything below must be dropped:
    history: [{ role: 'assistant', content: 'previous raw model text with token abc123' }],
    rawGoogleData: [{ summary: 'Private meeting', attendees: ['a@x.com'] }],
    n8nCredentialNames: ['My Cal'],
  });
  assert.deepEqual(Object.keys(ctx).sort(), ['credentialRequirements', 'planSpec']);
  assert.deepEqual(ctx.credentialRequirements, [{ credentialType: 'googleCalendarOAuth2Api', status: 'ready' }]);
  // no boundName/handle/id/token/rawGoogleData/history anywhere:
  const json = JSON.stringify(ctx);
  assert.doesNotMatch(json, /My Cal|h1|REAL|secret|token|Private meeting|a@x\.com|abc123|history/);
});

test('planSpec itself is structural only (no credential values embedded)', () => {
  const ctx = redactForPlannerContext({
    planSpec: { goal: 'g', steps: [{ capability: 'http_request', configuration: { url: { reference: 'https://x' } } }] },
    credentialRequirements: [],
  });
  assert.equal(ctx.planSpec.goal, 'g');
  assert.equal(ctx.planSpec.steps[0].capability, 'http_request');
});

test('missing inputs default to empty, never throw', () => {
  const ctx = redactForPlannerContext({});
  assert.deepEqual(ctx, { planSpec: null, credentialRequirements: [] });
});

test('assertPlannerContextClean rejects a context carrying forbidden fields', () => {
  assert.throws(() => assertPlannerContextClean({ planSpec: {}, credentialRequirements: [], history: [] }), /forbidden|clean/i);
  assert.throws(() => assertPlannerContextClean({ planSpec: {}, credentialRequirements: [{ credentialType: 't', status: 'ready', boundName: 'x' }] }), /boundName|forbidden/i);
});

test('assertPlannerContextClean passes a properly redacted context', () => {
  const ctx = redactForPlannerContext({ planSpec: { goal: 'g' }, credentialRequirements: [{ credentialType: 't', status: 'ready' }] });
  assert.doesNotThrow(() => assertPlannerContextClean(ctx));
});
