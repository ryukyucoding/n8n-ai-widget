'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationStore } = require('./conversationState');
const { redactForPlannerContext } = require('./plannerContextRedaction');
const { createConversationController, computeStatus } = require('./conversationController');

// Build a controller with injected mocks + a real conversation store.
function make({ planImpl, credsImpl, createImpl, validateImpl, evidence } = {}) {
  const store = createConversationStore({ now: () => 1000, ttlMs: 100000 });
  const seen = { plannerContexts: [], created: [], evidence: [] };
  const controller = createConversationController({
    store,
    redact: redactForPlannerContext,
    plan: planImpl || (async () => ({ outcome: 'ready_to_compile', spec: { schemaVersion: '1.0', goal: 'g', steps: [] }, assistantMessage: 'ok' })),
    resolveCredentials: credsImpl || (async () => ({ requirements: [], overall: 'ready', createDisposition: 'bind_and_create' })),
    compileAndCreate: createImpl || (async (spec) => { seen.created.push(spec); return { status: 200, payload: { workflowId: 'wf1' } }; }),
    validatePlanSpec: validateImpl || (() => {}), // real wiring injects the compiler's validateSpecification
    evidence: evidence || { record: (event) => seen.evidence.push(event) },
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

test('records sanitized evidence for start, refinement, cancel, and confirm actions', async () => {
  const { controller, seen } = make();
  const first = await controller.start('solo', 'sort todos');
  await controller.respond('solo', first.conversationId, 'sort descending');
  await controller.confirm('solo', first.conversationId);
  controller.cancel('solo', first.conversationId);
  assert.deepEqual(seen.evidence.map((event) => event.event), ['turn', 'turn', 'confirm', 'cancel']);
  assert.deepEqual(seen.evidence.map((event) => event.route), [
    'conversation/start', 'conversation/message', 'conversation/confirm', 'conversation/cancel',
  ]);
  assert.equal(seen.evidence[0].conversationId, first.conversationId);
  assert.equal(seen.evidence[2].outcome, 'created');
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

test('computeStatus mapping (hasSpec-gated)', () => {
  assert.equal(computeStatus('ready_to_compile', { overall: 'ready' }, false), 'planning'); // no spec -> never confirmable
  assert.equal(computeStatus('clarification_required', null, true), 'planning');
  assert.equal(computeStatus('unsupported_capability', null, true), 'planning');
  assert.equal(computeStatus('ready_to_compile', { overall: 'needs_choice' }, true), 'awaiting_credential_choice');
  assert.equal(computeStatus('ready_to_compile', { overall: 'ready' }, true), 'ready_to_confirm');
  assert.equal(computeStatus('ready_to_compile', { overall: 'setup_required' }, true), 'ready_to_confirm');
  // fail-closed on stale/unknown/missing credential state:
  assert.equal(computeStatus('ready_to_compile', { overall: 'stale' }, true), 'planning');
  assert.equal(computeStatus('ready_to_compile', { overall: 'weird' }, true), 'planning');
  assert.equal(computeStatus('ready_to_compile', null, true), 'planning');
});

test('planner receives a SANITIZED previousSpec, never the raw server spec', async () => {
  const seenPrev = [];
  const { controller } = make({ planImpl: async ({ previousSpec }) => {
    seenPrev.push(previousSpec);
    return { outcome: 'ready_to_compile', assistantMessage: 'ok', spec: {
      schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'g', requiredUserSetup: [],
      expectedOutput: { deliveryShape: 'one_object', fields: ['x'] },
      steps: [{ id: 's', capability: 'http_request', requiredUserSetup: [], configuration: { operation: 'x', query: 'PRIVATE_QUERY' } }],
    } };
  } });
  const r = await controller.start('solo', 'a');            // stores raw spec (with query)
  await controller.respond('solo', r.conversationId, 'b');  // 2nd turn: previousSpec must be sanitized
  assert.equal(seenPrev[0], null);                          // no prior plan on first turn
  assert.ok(seenPrev[1]);
  assert.doesNotMatch(JSON.stringify(seenPrev[1]), /PRIVATE_QUERY|query/); // sanitized, not raw
});

test('a model spec carrying a forbidden/secret field is rejected, never stored/created', async () => {
  const { controller, seen } = make({ planImpl: async () => ({ outcome: 'ready_to_compile', assistantMessage: 'ok', spec: { goal: 'g', steps: [{ id: 's', capability: 'http_request', configuration: { token: 'sk-secret-value' } }] } }) });
  const r = await controller.start('solo', 'x');
  assert.equal(r.outcome, 'unsafe_plan_rejected');
  assert.equal(r.view.status, 'planning');
  assert.equal(r.view.planSpec, null);   // bad spec never stored
  assert.equal(seen.created.length, 0);
});

test('injected validatePlanSpec rejects a structurally invalid model spec (fail-closed)', async () => {
  const { controller } = make({
    planImpl: async () => ({ outcome: 'ready_to_compile', assistantMessage: 'ok', spec: { goal: 'g', steps: [] } }),
    validateImpl: (spec) => { throw new Error('final step must produce declared output fields'); },
  });
  const r = await controller.start('solo', 'x');
  assert.equal(r.outcome, 'unsafe_plan_rejected');
  assert.equal(r.view.planSpec, null);
});

test('confirm fails closed if re-resolution is stale/unknown (not ready/setup_required/needs_choice)', async () => {
  let call = 0;
  const created = [];
  const { controller } = make({
    credsImpl: async () => { call += 1; return call === 1 ? { requirements: [], overall: 'ready', createDisposition: 'bind_and_create' } : { requirements: [], overall: 'stale' }; },
    createImpl: async (s, res) => { created.push(res); return { status: 200, payload: {} }; },
  });
  const r = await controller.start('solo', 'x');
  const c = await controller.confirm('solo', r.conversationId);
  assert.equal(c.error, 'credential_unresolved');
  assert.equal(created.length, 0);
});

test('ready_to_compile with null spec and no prior plan stays planning (not confirmable)', async () => {
  const { controller } = make({ planImpl: async () => ({ outcome: 'ready_to_compile', spec: null, assistantMessage: 'hmm' }) });
  const r = await controller.start('solo', 'x');
  assert.equal(r.view.status, 'planning');
  const c = await controller.confirm('solo', r.conversationId);
  assert.equal(c.error, 'not_ready_to_confirm');
});

test('raw user message is scrubbed before reaching the planner (secret never sent to qwen)', async () => {
  const seenMessages = [];
  const { controller } = make({ planImpl: async ({ message }) => { seenMessages.push(message); return { outcome: 'clarification_required', spec: null, assistantMessage: '?' }; } });
  const r = await controller.start('solo', 'use my key eyJhbGciOiJIUzI1NiJ9.abcdefghij and read calendar');
  assert.doesNotMatch(seenMessages[0], /eyJhbGciOiJIUzI1NiJ9\.abcdefghij/);
  assert.match(seenMessages[0], /«redacted»/);
  assert.equal(r.inputRedacted, true);
});

test('confirm RE-RESOLVES credentials; a now-needs_choice (stale/ambiguous) blocks create', async () => {
  let call = 0;
  const created = [];
  const { controller } = make({
    credsImpl: async () => { call += 1; return call === 1 ? { requirements: [], overall: 'ready', createDisposition: 'bind_and_create' } : { requirements: [{ credentialType: 't', status: 'needs_choice' }], overall: 'needs_choice', createDisposition: 'create_inactive_draft' }; },
    createImpl: async (spec, resolution) => { created.push({ spec, resolution }); return { status: 200, payload: {} }; },
  });
  const r = await controller.start('solo', 'x'); // plan-time creds ready -> ready_to_confirm
  assert.equal(r.view.status, 'ready_to_confirm');
  const c = await controller.confirm('solo', r.conversationId); // confirm-time creds needs_choice
  assert.equal(c.error, 'credential_choice_required');
  assert.equal(created.length, 0); // never created
  assert.equal(c.view.status, 'awaiting_credential_choice');
});

test('confirm passes the freshly-resolved credential resolution to compileAndCreate', async () => {
  const created = [];
  const { controller } = make({
    credsImpl: async () => ({ requirements: [{ credentialType: 't', status: 'ready', selected: 'h' }], overall: 'ready', createDisposition: 'bind_and_create' }),
    createImpl: async (spec, resolution) => { created.push(resolution); return { status: 200, payload: {} }; },
  });
  const r = await controller.start('solo', 'x');
  await controller.confirm('solo', r.conversationId);
  assert.equal(created.length, 1);
  assert.equal(created[0].createDisposition, 'bind_and_create');
});

test('controller construction FAILS CLOSED without a validatePlanSpec (canonical validator)', () => {
  const store = createConversationStore({ now: () => 0, ttlMs: 1 });
  assert.throws(() => createConversationController({
    store,
    redact: redactForPlannerContext,
    plan: async () => ({ outcome: 'clarification_required', spec: null, assistantMessage: '?' }),
    resolveCredentials: async () => ({ requirements: [], overall: 'ready' }),
    compileAndCreate: async () => ({ status: 200, payload: {} }),
    // validatePlanSpec intentionally omitted
  }), /validatePlanSpec|required/i);
});
