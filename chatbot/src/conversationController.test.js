'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationStore } = require('./conversationState');
const { redactForPlannerContext } = require('./plannerContextRedaction');
const { createConversationController, computeStatus } = require('./conversationController');

// Build a controller with injected mocks + a real conversation store.
function make({ planImpl, credsImpl, createImpl } = {}) {
  const store = createConversationStore({ now: () => 1000, ttlMs: 100000 });
  const seen = { plannerContexts: [], created: [] };
  const controller = createConversationController({
    store,
    redact: redactForPlannerContext,
    plan: planImpl || (async () => ({ outcome: 'ready_to_compile', spec: { schemaVersion: '1.0', goal: 'g', steps: [] }, assistantMessage: 'ok' })),
    resolveCredentials: credsImpl || (async () => ({ requirements: [], overall: 'ready', createDisposition: 'bind_and_create' })),
    compileAndCreate: createImpl || (async (spec) => { seen.created.push(spec); return { status: 200, payload: { workflowId: 'wf1' } }; }),
  });
  return { store, controller, seen };
}

test('start creates a conversation and returns a sanitized view + assistant message', async () => {
  const { controller } = make();
  const r = await controller.start('solo', 'read my calendar');
  assert.ok(r.conversationId);
  assert.equal(r.assistantMessage, 'ok');
  assert.equal(r.view.status, 'ready_to_confirm'); // valid spec + creds ready
  assert.ok(r.view.planSpec);
});

test('planner is always called with a REDACTED context (no raw credential/secret fields)', async () => {
  const contexts = [];
  const { controller } = make({ planImpl: async ({ redactedContext }) => { contexts.push(redactedContext); return { outcome: 'ready_to_compile', spec: { goal: 'g', steps: [] }, assistantMessage: 'x' }; } });
  const r = await controller.start('solo', 'hi');
  await controller.respond('solo', r.conversationId, 'refine');
  for (const c of contexts) {
    assert.deepEqual(Object.keys(c).sort(), ['credentialRequirements', 'planSpec']);
  }
});

test('clarification / unsupported outcomes keep status planning', async () => {
  const { controller } = make({ planImpl: async () => ({ outcome: 'clarification_required', spec: null, assistantMessage: 'which calendar?' }) });
  const r = await controller.start('solo', 'do a thing');
  assert.equal(r.view.status, 'planning');
});

test('needs_choice credentials -> awaiting_credential_choice', async () => {
  const { controller } = make({ credsImpl: async () => ({ requirements: [{ credentialType: 't', status: 'needs_choice' }], overall: 'needs_choice', createDisposition: 'create_inactive_draft' }) });
  const r = await controller.start('solo', 'read gmail');
  assert.equal(r.view.status, 'awaiting_credential_choice');
});

test('respond refines the same conversation and updates the plan', async () => {
  let n = 0;
  const { controller, store } = make({ planImpl: async () => { n += 1; return { outcome: 'ready_to_compile', spec: { goal: `plan-${n}`, steps: [] }, assistantMessage: 'ok' }; } });
  const r = await controller.start('solo', 'a');
  const r2 = await controller.respond('solo', r.conversationId, 'b');
  assert.equal(r2.view.planSpec.goal, 'plan-2');
});

test('confirm compiles the FULL server-side spec (not the sanitized view) and marks done', async () => {
  const fullSpec = { schemaVersion: '1.0', goal: 'g', steps: [{ id: 's', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} }], _serverOnly: 'keepme' };
  const { controller, seen } = make({ planImpl: async () => ({ outcome: 'ready_to_compile', spec: fullSpec, assistantMessage: 'ok' }) });
  const r = await controller.start('solo', 'go');
  const c = await controller.confirm('solo', r.conversationId);
  assert.equal(c.result.status, 200);
  assert.equal(c.view.status, 'done');
  assert.equal(seen.created.length, 1);
  assert.equal(seen.created[0]._serverOnly, 'keepme'); // authoritative full spec, server-side
});

test('confirm refused unless ready_to_confirm', async () => {
  const { controller } = make({ planImpl: async () => ({ outcome: 'clarification_required', spec: null, assistantMessage: '?' }) });
  const r = await controller.start('solo', 'x');
  const c = await controller.confirm('solo', r.conversationId);
  assert.equal(c.error, 'not_ready_to_confirm');
});

test('cancel returns to planning and keeps the plan', async () => {
  const { controller, store } = make();
  const r = await controller.start('solo', 'x');
  const c = controller.cancel('solo', r.conversationId);
  assert.equal(c.view.status, 'planning');
  assert.ok(c.view.planSpec); // plan kept
});

test('unknown conversation / wrong caller -> error, no throw', async () => {
  const { controller } = make();
  assert.equal((await controller.respond('solo', 'nope', 'x')).error, 'conversation_not_found');
  const r = await controller.start('solo', 'x');
  assert.equal((await controller.respond('other', r.conversationId, 'x')).error, 'conversation_not_found');
});

test('computeStatus mapping', () => {
  assert.equal(computeStatus('clarification_required', null), 'planning');
  assert.equal(computeStatus('unsupported_capability', null), 'planning');
  assert.equal(computeStatus('ready_to_compile', { overall: 'needs_choice' }), 'awaiting_credential_choice');
  assert.equal(computeStatus('ready_to_compile', { overall: 'ready' }), 'ready_to_confirm');
  assert.equal(computeStatus('ready_to_compile', { overall: 'setup_required' }), 'ready_to_confirm');
});
