'use strict';

// Source-level regression guards for the solo Calendar chat chip. chat.html is
// not executed here; these assert the wiring that prevents the mode-switch
// handler from hijacking the chip (brain2 blocker) and the no-secret guidance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');

test('solo chip is NOT a .mode-btn (so switchMode(undefined) cannot fire on click)', () => {
  const m = src.match(/<button id="solo-cal-chip"[^>]*>/);
  assert.ok(m, 'solo-cal-chip button present');
  assert.doesNotMatch(m[0], /class="[^"]*\bmode-btn\b[^"]*"/); // not caught by .mode-btn selector
  assert.match(m[0], /class="solo-action-btn"/);
  assert.doesNotMatch(m[0], /data-mode=/); // no data-mode, so it could never switch modes
});

test('solo chip is wired to createSoloCalendar (not the mode-switch handler)', () => {
  assert.match(src, /soloCalChip\.addEventListener\('click', createSoloCalendar\)/);
});

test('chip visibility is gated on the server soloSkills flag', () => {
  assert.match(src, /soloCalendarEnabled = !!\(config\.soloSkills && config\.soloSkills\.calendarRead\)/);
  assert.match(src, /soloActions\.hidden = !\(activeMode === 'compiler' && soloCalendarEnabled\)/);
});

test('credential guidance renders from setupManifest, no credential value/token/id fields', () => {
  assert.match(src, /data\.setupManifest && data\.setupManifest\.credentialRequirements/);
  // guidance only reads displayName/credentialType from requirements — never a value/token/secret/id
  assert.doesNotMatch(src, /r\.(value|token|secret|refresh|accessToken)\b/);
});
