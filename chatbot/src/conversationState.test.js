'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationStore } = require('./conversationState');

function fixedClock(start) { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; }

test('create returns an opaque id, planning status, empty history, caller-bound', () => {
  const clk = fixedClock(1000);
  const store = createConversationStore({ now: clk.now, ttlMs: 10000 });
  const { conversationId, state } = store.create('caller-1');
  assert.match(conversationId, /^[A-Za-z0-9_-]{16,}$/); // opaque, url-safe
  assert.equal(state.status, 'planning');
  assert.deepEqual(state.history, []);
  assert.equal(state.planSpec, null);
});

test('get requires matching callerId and existing id', () => {
  const clk = fixedClock(0);
  const store = createConversationStore({ now: clk.now, ttlMs: 10000 });
  const { conversationId } = store.create('caller-1');
  assert.ok(store.get(conversationId, 'caller-1'));
  assert.equal(store.get(conversationId, 'caller-2'), null); // wrong caller
  assert.equal(store.get('nope', 'caller-1'), null); // unknown id
});

test('TTL expiry: get returns null after ttl since last update', () => {
  const clk = fixedClock(0);
  const store = createConversationStore({ now: clk.now, ttlMs: 5000 });
  const { conversationId } = store.create('c');
  clk.advance(4999);
  assert.ok(store.get(conversationId, 'c'));
  clk.advance(2); // now 5001 past updatedAt
  assert.equal(store.get(conversationId, 'c'), null);
});

test('update patches plan/history, bumps updatedAt, rejects wrong caller/expired', () => {
  const clk = fixedClock(0);
  const store = createConversationStore({ now: clk.now, ttlMs: 5000 });
  const { conversationId } = store.create('c');
  clk.advance(1000);
  const s = store.update(conversationId, 'c', { planSpec: { goal: 'g' }, history: [{ role: 'user', content: 'x' }] });
  assert.equal(s.planSpec.goal, 'g');
  assert.equal(s.history.length, 1);
  assert.throws(() => store.update(conversationId, 'other', { planSpec: {} }), /caller|not found/i);
  clk.advance(6000);
  assert.throws(() => store.update(conversationId, 'c', { planSpec: {} }), /expired|not found/i);
});

test('cancel keeps plan + history, returns status to planning (non-destructive)', () => {
  const clk = fixedClock(0);
  const store = createConversationStore({ now: clk.now, ttlMs: 10000 });
  const { conversationId } = store.create('c');
  store.update(conversationId, 'c', { planSpec: { goal: 'g' }, history: [{ role: 'user', content: 'x' }], status: 'ready_to_confirm' });
  const s = store.cancel(conversationId, 'c');
  assert.equal(s.status, 'planning');
  assert.equal(s.planSpec.goal, 'g'); // plan kept
  assert.equal(s.history.length, 1); // history kept
});

test('publicView exposes only conversationId + status + plan + sanitized credentials (no callerId/handles)', () => {
  const clk = fixedClock(0);
  const store = createConversationStore({ now: clk.now, ttlMs: 10000 });
  const { conversationId } = store.create('caller-secret');
  store.update(conversationId, 'caller-secret', {
    planSpec: { goal: 'g' },
    credentials: { requirements: [{ credentialType: 't', status: 'ready', selected: 'HANDLE_X' }] },
  });
  const view = store.publicView(conversationId, 'caller-secret');
  assert.deepEqual(Object.keys(view).sort(), ['conversationId', 'credentials', 'planSpec', 'status']);
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /caller-secret|HANDLE_X/); // no callerId, no selection handle
  assert.equal(view.credentials[0].credentialType, 't');
  assert.equal(view.credentials[0].status, 'ready');
});
