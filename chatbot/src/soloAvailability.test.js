'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { soloAvailability } = require('./soloAvailability');

const ok = { soloMode: true, runtimeCompilerEnabled: true, apiKeyPresent: true };

test('available only when all preconditions hold', () => {
  assert.deepEqual(soloAvailability(ok), { available: true, status: 200, error: null });
});

test('disabled when SOLO_CREDENTIAL_MODE is off (default)', () => {
  const r = soloAvailability({ ...ok, soloMode: false });
  assert.equal(r.available, false);
  assert.equal(r.status, 404);
  assert.match(r.error, /solo/i);
});

test('disabled when runtime compiler beta is off', () => {
  const r = soloAvailability({ ...ok, runtimeCompilerEnabled: false });
  assert.equal(r.available, false);
  assert.equal(r.status, 404);
});

test('unavailable (503) when no n8n API key', () => {
  const r = soloAvailability({ ...ok, apiKeyPresent: false });
  assert.equal(r.available, false);
  assert.equal(r.status, 503);
  assert.match(r.error, /api key/i);
});

test('solo-off takes precedence over other missing preconditions', () => {
  const r = soloAvailability({ soloMode: false, runtimeCompilerEnabled: false, apiKeyPresent: false });
  assert.equal(r.status, 404);
  assert.match(r.error, /solo/i);
});
