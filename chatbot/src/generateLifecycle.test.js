'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GenerateStageError, runGenerateLifecycle } = require('./generateLifecycle');

function defaults(overrides = {}) { return { planningMs: 30, generationMs: 30, verificationMs: 30, n8nCreateMs: 30, postActionMs: 30, ...overrides }; }
function noop() {}

test('planner timeout never enters Create Model', async () => {
  let generated = false;
  await assert.rejects(() => runGenerateLifecycle({ signal: new AbortController().signal, emit: noop, timeouts: defaults({ planningMs: 5 }), planner: () => new Promise(() => {}), generator: () => { generated = true; }, verifier: noop, createWorkflow: noop, postActionVerify: noop }), (e) => e instanceof GenerateStageError && e.stage === 'planning');
  assert.equal(generated, false);
});
test('Create Model timeout never calls n8n API', async () => {
  let posted = false;
  await assert.rejects(() => runGenerateLifecycle({ signal: new AbortController().signal, emit: noop, timeouts: defaults({ generationMs: 5 }), planner: () => ({}), generator: () => new Promise(() => {}), verifier: noop, createWorkflow: () => { posted = true; }, postActionVerify: noop }), /generation timed out/);
  assert.equal(posted, false);
});
test('abort before n8n POST stops lifecycle', async () => {
  const controller = new AbortController(); let posted = false;
  await assert.rejects(() => runGenerateLifecycle({ signal: controller.signal, emit: (event) => { if (event === 'structural_validation_completed') controller.abort(); }, timeouts: defaults(), planner: () => ({}), generator: () => ({}), verifier: () => ({}), createWorkflow: () => { posted = true; }, postActionVerify: noop }), /cancelled before n8n_create/);
  assert.equal(posted, false);
});
test('emits ordered lifecycle events', async () => {
  const events=[];
  await runGenerateLifecycle({ signal:new AbortController().signal, emit:(e)=>events.push(e), timeouts:defaults(), planner:()=>({}), generator:()=>({}), verifier:(w)=>w, createWorkflow:()=>({id:'x'}), postActionVerify:()=>({status:'pass'}) });
  assert.deepEqual(events, ['request_received','planning_started','planning_completed','generation_started','generation_completed','structural_validation_started','structural_validation_completed','n8n_create_started','n8n_create_completed','post_action_verification_started','post_action_verification_completed','completed']);
});

test('timeout aborts the stage signal before returning its error', async () => {
  const events = [];
  let stageSignal;
  await assert.rejects(() => runGenerateLifecycle({
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    timeouts: defaults({ planningMs: 5 }),
    planner: (signal) => {
      stageSignal = signal;
      return new Promise(() => {});
    },
    generator: noop,
    verifier: noop,
    createWorkflow: noop,
    postActionVerify: noop,
  }), /planning timed out/);
  assert.equal(stageSignal.aborted, true);
  assert.deepEqual(events, ['request_received', 'planning_started']);
});
