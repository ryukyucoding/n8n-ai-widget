'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isConfirmedInactive,
  isValidWorkflowId,
  enforceInactiveDraft,
  finalizeSoloCreate,
  createAndFinalizeSoloWorkflow,
} = require('./soloInactiveGuard');

function harness({ created, readbacks = [], deactivateThrows = false, deleteThrows = false }) {
  const calls = { deactivate: [], get: [], delete: [] };
  let readIdx = 0;
  return {
    calls,
    args: {
      created,
      deactivate: async (id) => { calls.deactivate.push(id); if (deactivateThrows) throw new Error('n8n_deactivate_failed_500'); },
      getWorkflow: async (id) => { calls.get.push(id); return readbacks[readIdx++]; },
      deleteWorkflow: async (id) => { calls.delete.push(id); if (deleteThrows) throw new Error('n8n_delete_failed_500'); },
    },
  };
}

test('isConfirmedInactive only trusts explicit active === false', () => {
  assert.equal(isConfirmedInactive({ id: '1', active: false }), true);
  assert.equal(isConfirmedInactive({ id: '1', active: true }), false);
  assert.equal(isConfirmedInactive({ id: '1' }), false);
  assert.equal(isConfirmedInactive(null), false);
});

test('isValidWorkflowId rejects non-scalar / malformed ids before path use', () => {
  for (const good of ['abc123', 'ID_-9', 'x', 5, '00000000-fake-ok0']) assert.equal(isValidWorkflowId(good), true, `${good}`);
  for (const bad of ['', null, undefined, {}, [], 'a/b', 'a b', 'a;rm', '../x', 'a'.repeat(129)]) assert.equal(isValidWorkflowId(bad), false, `${JSON.stringify(bad)}`);
});

test('confirmed-inactive create: trusts response, no n8n calls', async () => {
  const h = harness({ created: { id: 'wf1', active: false } });
  const r = await enforceInactiveDraft(h.args);
  assert.deepEqual(r, { ok: true, workflow: { id: 'wf1', active: false }, active: false, deactivated: false });
  assert.deepEqual(h.calls, { deactivate: [], get: [], delete: [] });
});

test('inactive but missing id -> unmanageable (usable success requires an addressable id)', async () => {
  const h = harness({ created: { active: false } });
  await assert.rejects(() => enforceInactiveDraft(h.args), (e) => { assert.equal(e.unmanageable, true); return true; });
  assert.deepEqual(h.calls, { deactivate: [], get: [], delete: [] });
});

test('active:true -> deactivate + readback confirms; returns VERIFIED workflow', async () => {
  const h = harness({ created: { id: 'wf1', active: true }, readbacks: [{ id: 'wf1', active: false, name: 'verified' }] });
  const r = await enforceInactiveDraft(h.args);
  assert.equal(r.deactivated, true);
  assert.equal(r.workflow.active, false);
  assert.equal(r.workflow.name, 'verified');
  assert.deepEqual(h.calls.delete, []);
});

test('active:true with NO usable id -> unmanageable escalation, no API calls (cannot orphan-delete)', async () => {
  const h = harness({ created: { active: true } });
  await assert.rejects(() => enforceInactiveDraft(h.args), (e) => { assert.equal(e.unmanageable, true); return true; });
  assert.deepEqual(h.calls, { deactivate: [], get: [], delete: [] });
});

test('active:true with malformed id -> unmanageable (no path built)', async () => {
  const h = harness({ created: { id: 'a/b;rm', active: true } });
  await assert.rejects(() => enforceInactiveDraft(h.args), (e) => { assert.equal(e.unmanageable, true); return true; });
  assert.deepEqual(h.calls.deactivate, []);
});

test('cannot confirm inactive -> DELETE (orphan prevention) + deleted error', async () => {
  const h = harness({ created: { id: 'wf1', active: true }, readbacks: [{ id: 'wf1', active: true }, { id: 'wf1', active: true }] });
  await assert.rejects(() => enforceInactiveDraft(h.args), (e) => { assert.equal(e.deleted, true); assert.equal(e.workflowId, 'wf1'); return true; });
  assert.deepEqual(h.calls.delete, ['wf1']);
});

test('unconfirmed AND delete fails -> cleanupFailed with id', async () => {
  const h = harness({ created: { id: 'wf1', active: true }, readbacks: [{ id: 'wf1', active: true }, { id: 'wf1', active: true }], deleteThrows: true });
  await assert.rejects(() => enforceInactiveDraft(h.args), (e) => { assert.equal(e.cleanupFailed, true); assert.equal(e.workflowId, 'wf1'); return true; });
});

// ---- finalizeSoloCreate (route-level logic) ----
const fns = { deactivate: async () => {}, getWorkflow: async () => ({ active: false }), deleteWorkflow: async () => {} };

test('finalizeSoloCreate passes through non-200 create results unchanged', async () => {
  const result = { status: 422, payload: { error: 'x', code: 'beta_static_verification_failed' } };
  assert.deepEqual(await finalizeSoloCreate({ result, ...fns }), result);
});

test('finalizeSoloCreate success (active:false valid id) -> 200 inactiveConfirmed', async () => {
  const result = { status: 200, payload: { workflow: { id: 'wf1', active: false }, workflowUrl: 'u' } };
  const out = await finalizeSoloCreate({ result, ...fns });
  assert.equal(out.status, 200);
  assert.equal(out.payload.inactiveConfirmed, true);
  assert.equal(out.payload.deactivated, false);
  assert.equal(out.payload.workflow.active, false);
  assert.equal(out.payload.workflowUrl, 'u');
});

test('finalizeSoloCreate create-success but NO id -> 500 solo_created_unmanageable', async () => {
  const result = { status: 200, payload: { workflow: { active: true } } };
  const out = await finalizeSoloCreate({ result, ...fns });
  assert.equal(out.status, 500);
  assert.equal(out.payload.code, 'solo_created_unmanageable');
});

test('finalizeSoloCreate inactive-but-no-id -> 500 solo_created_unmanageable (no /workflow/undefined success)', async () => {
  const out = await finalizeSoloCreate({ result: { status: 200, payload: { workflow: { active: false } } }, ...fns });
  assert.equal(out.status, 500);
  assert.equal(out.payload.code, 'solo_created_unmanageable');
});

test('finalizeSoloCreate 200 with no workflow object -> unmanageable escalation', async () => {
  const out = await finalizeSoloCreate({ result: { status: 200, payload: {} }, ...fns });
  assert.equal(out.status, 500);
  assert.equal(out.payload.code, 'solo_created_unmanageable');
});

test('finalizeSoloCreate cannot-confirm -> 500 solo_inactive_unconfirmed (deleted)', async () => {
  const result = { status: 200, payload: { workflow: { id: 'wf1', active: true } } };
  const out = await finalizeSoloCreate({
    result,
    deactivate: async () => {},
    getWorkflow: async () => ({ id: 'wf1', active: true }),
    deleteWorkflow: async () => {},
  });
  assert.equal(out.status, 500);
  assert.equal(out.payload.code, 'solo_inactive_unconfirmed');
});

// ---- createAndFinalizeSoloWorkflow (solo-owned create orchestrator) ----
const passVerify = async (wf) => ({ status: 'pass', workflow: wf });
const noop = { deactivate: async () => {}, getWorkflow: async () => ({ active: false }), deleteWorkflow: async () => {} };

test('createAndFinalize: static verify fail -> 422, create not called', async () => {
  let created = 0;
  const out = await createAndFinalizeSoloWorkflow({
    skeleton: { name: 'x' }, staticVerify: async () => ({ status: 'error' }),
    createWorkflow: async () => { created += 1; return {}; }, ...noop,
  });
  assert.equal(out.status, 422);
  assert.equal(created, 0);
});

test('createAndFinalize: create throws -> 500 beta_create_failed', async () => {
  const out = await createAndFinalizeSoloWorkflow({
    skeleton: {}, staticVerify: passVerify,
    createWorkflow: async () => { throw new Error('n8n_create_failed_500'); }, ...noop,
  });
  assert.equal(out.status, 500);
  assert.equal(out.payload.code, 'beta_create_failed');
});

test('createAndFinalize: inactive w/ id -> 200 inactiveConfirmed + url + metadata', async () => {
  const out = await createAndFinalizeSoloWorkflow({
    skeleton: {}, publicUrl: 'http://n8n', metadata: { soloOnly: true },
    staticVerify: passVerify,
    createWorkflow: async () => ({ id: 'wf9', name: 'cal', active: false }), ...noop,
  });
  assert.equal(out.status, 200);
  assert.equal(out.payload.inactiveConfirmed, true);
  assert.equal(out.payload.workflowUrl, 'http://n8n/workflow/wf9');
  assert.equal(out.payload.soloOnly, true);
});

test('createAndFinalize: create SUCCESS then post-create verification (readback) THROWS -> orphan deleted by retained id', async () => {
  const deleted = [];
  const out = await createAndFinalizeSoloWorkflow({
    skeleton: {}, staticVerify: passVerify,
    createWorkflow: async () => ({ id: 'wf9', active: true }),
    deactivate: async () => {},
    getWorkflow: async () => { throw new Error('verify_readback_failed'); },
    deleteWorkflow: async (id) => { deleted.push(id); },
  });
  assert.equal(out.status, 500);
  assert.equal(out.payload.code, 'solo_inactive_unconfirmed');
  assert.deepEqual(deleted, ['wf9']);
});

test('createAndFinalize: create returns no id -> 500 solo_created_unmanageable', async () => {
  const out = await createAndFinalizeSoloWorkflow({
    skeleton: {}, staticVerify: passVerify,
    createWorkflow: async () => ({ active: true }), ...noop,
  });
  assert.equal(out.status, 500);
  assert.equal(out.payload.code, 'solo_created_unmanageable');
});
