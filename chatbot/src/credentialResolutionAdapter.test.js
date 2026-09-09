'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCredentialType, resolveCredentialRequirements } = require('./credentialResolutionAdapter');

// Injected candidate lister returns SANITIZED candidates (server strips secrets):
// { handle (opaque), displayName, createdAt, lastUsedAt? }. The adapter only ranks
// + selects; it must never surface anything beyond handle/displayName/status.
function lister(map) {
  return async (type) => (map[type] || []);
}

test('0 candidates -> setup_required, no selection', async () => {
  const r = await resolveCredentialType('googleCalendarOAuth2Api', lister({}));
  assert.equal(r.status, 'setup_required');
  assert.equal(r.count, 0);
  assert.equal(r.selected, null);
  assert.deepEqual(r.candidates, []);
});

test('exactly 1 -> ready, auto-selected (silent bind)', async () => {
  const r = await resolveCredentialType('googleCalendarOAuth2Api', lister({
    googleCalendarOAuth2Api: [{ handle: 'h1', displayName: 'My Cal', createdAt: 5 }],
  }));
  assert.equal(r.status, 'ready');
  assert.equal(r.count, 1);
  assert.equal(r.selected, 'h1');
  assert.equal(r.default, null);
});

test('>1 -> needs_choice, default = most-recently-used', async () => {
  const r = await resolveCredentialType('gmailOAuth2', lister({
    gmailOAuth2: [
      { handle: 'a', displayName: 'A', createdAt: 100, lastUsedAt: 10 },
      { handle: 'b', displayName: 'B', createdAt: 1, lastUsedAt: 50 }, // most recently used
      { handle: 'c', displayName: 'C', createdAt: 200 },               // never used
    ],
  }));
  assert.equal(r.status, 'needs_choice');
  assert.equal(r.count, 3);
  assert.equal(r.default, 'b'); // highest lastUsedAt wins
  assert.equal(r.selected, 'b');
});

test('>1 with NONE used -> default = most-recently-created', async () => {
  const r = await resolveCredentialType('gmailOAuth2', lister({
    gmailOAuth2: [
      { handle: 'a', displayName: 'A', createdAt: 100 },
      { handle: 'b', displayName: 'B', createdAt: 300 }, // newest
      { handle: 'c', displayName: 'C', createdAt: 200 },
    ],
  }));
  assert.equal(r.status, 'needs_choice');
  assert.equal(r.default, 'b');
});

test('output is sanitized: only handle + displayName in candidates, never secrets/ids', async () => {
  const r = await resolveCredentialType('x', async () => ([
    { handle: 'h', displayName: 'D', createdAt: 1, id: 'REAL_N8N_ID', secret: 'tok', apiKey: 'k' },
  ]));
  assert.deepEqual(Object.keys(r.candidates[0]).sort(), ['displayName', 'handle']);
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /REAL_N8N_ID|secret|apiKey|tok/);
});

test('resolveCredentialRequirements aggregates + overall status', async () => {
  const l = lister({
    googleCalendarOAuth2Api: [{ handle: 'g1', displayName: 'G', createdAt: 1 }],
    gmailOAuth2: [],
  });
  const out = await resolveCredentialRequirements(['googleCalendarOAuth2Api', 'gmailOAuth2'], l);
  assert.equal(out.requirements.length, 2);
  // any setup_required -> overall setup_required; else any needs_choice -> needs_choice; else ready
  assert.equal(out.overall, 'setup_required');
  assert.equal(out.createDisposition, 'create_inactive_draft');
});

test('all ready -> overall ready, bind_and_create', async () => {
  const l = lister({ a: [{ handle: 'a1', displayName: 'A', createdAt: 1 }] });
  const out = await resolveCredentialRequirements(['a'], l);
  assert.equal(out.overall, 'ready');
  assert.equal(out.createDisposition, 'bind_and_create');
});

test('needs_choice present (no setup_required) -> overall needs_choice, draft until chosen', async () => {
  const l = lister({ a: [{ handle: 'a1', displayName: 'A', createdAt: 1 }, { handle: 'a2', displayName: 'B', createdAt: 2 }] });
  const out = await resolveCredentialRequirements(['a'], l);
  assert.equal(out.overall, 'needs_choice');
  assert.equal(out.createDisposition, 'create_inactive_draft');
});

test('default tie-break is deterministic: equal lastUsedAt -> createdAt -> handle', async () => {
  const r = await resolveCredentialType('t', async () => ([
    { handle: 'zzz', displayName: 'Z', createdAt: 5, lastUsedAt: 100 },
    { handle: 'aaa', displayName: 'A', createdAt: 5, lastUsedAt: 100 },
    { handle: 'mmm', displayName: 'M', createdAt: 9, lastUsedAt: 100 },
  ]));
  assert.equal(r.default, 'mmm'); // higher createdAt breaks the lastUsedAt tie
});

test('non-finite lastUsedAt (NaN/undefined) is treated as unused', async () => {
  const r = await resolveCredentialType('t', async () => ([
    { handle: 'a', displayName: 'A', createdAt: 1, lastUsedAt: NaN },
    { handle: 'b', displayName: 'B', createdAt: 2, lastUsedAt: undefined },
  ]));
  assert.equal(r.default, 'b'); // none used -> most-recently-created
});
