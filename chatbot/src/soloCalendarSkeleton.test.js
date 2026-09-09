'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCalendarReadSkeleton,
  buildCalendarReadManifest,
  SOLO_CALENDAR_SKILL,
  MAX_CALENDAR_LIMIT,
  DEFAULT_CALENDAR_LIMIT,
  CALENDAR_CRED_TYPE,
  CALENDAR_NODE_TYPE,
} = require('./soloCalendarSkeleton');

// Deep-scan helper: collect every string key + string value in an object tree.
function walkStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); walkStrings(v, out); }
  }
  return out;
}
const SECRET_PATTERNS = /token|secret|password|refresh|access_token|bearer |eyJ[A-Za-z0-9]|[A-Za-z0-9_-]{40,}/i;

test('skeleton has manual trigger -> googleCalendar getAll, inactive, no write', () => {
  const wf = buildCalendarReadSkeleton();
  assert.equal(wf.active, false);
  const types = wf.nodes.map((n) => n.type);
  assert.ok(types.includes('n8n-nodes-base.manualTrigger'));
  assert.ok(types.includes(CALENDAR_NODE_TYPE));
  const cal = wf.nodes.find((n) => n.type === CALENDAR_NODE_TYPE);
  assert.equal(cal.typeVersion, 1.3);
  assert.equal(cal.parameters.resource, 'event');
  assert.equal(cal.parameters.operation, 'getAll'); // read-only
  assert.equal(cal.parameters.returnAll, false);
  assert.equal(cal.parameters.limit, DEFAULT_CALENDAR_LIMIT);
  assert.deepEqual(cal.parameters.options, {});
});

test('credential is by-name with empty id (no secret)', () => {
  const wf = buildCalendarReadSkeleton({ credentialName: 'My Cal' });
  const cal = wf.nodes.find((n) => n.type === CALENDAR_NODE_TYPE);
  assert.deepEqual(cal.credentials, { [CALENDAR_CRED_TYPE]: { id: '', name: 'My Cal' } });
});

test('timeMin/timeMax are never emitted, and are rejected if supplied', () => {
  const wf = buildCalendarReadSkeleton();
  const cal = wf.nodes.find((n) => n.type === CALENDAR_NODE_TYPE);
  assert.equal('timeMin' in cal.parameters, false);
  assert.equal('timeMax' in cal.parameters, false);
  assert.ok(!('timeMin' in (cal.parameters.options || {})));
  assert.throws(() => buildCalendarReadSkeleton({ timeMin: '2026-01-01T00:00:00Z' }), /timeMin|timeMax|not allowed/i);
  assert.throws(() => buildCalendarReadSkeleton({ timeMax: '2026-02-01T00:00:00Z' }), /timeMin|timeMax|not allowed/i);
});

test('limit is bounded 1..MAX; invalid rejected; default applied', () => {
  assert.equal(buildCalendarReadSkeleton({ limit: 25 }).nodes.find((n) => n.type === CALENDAR_NODE_TYPE).parameters.limit, 25);
  assert.equal(buildCalendarReadSkeleton().nodes.find((n) => n.type === CALENDAR_NODE_TYPE).parameters.limit, DEFAULT_CALENDAR_LIMIT);
  assert.throws(() => buildCalendarReadSkeleton({ limit: 0 }), /limit/i);
  assert.throws(() => buildCalendarReadSkeleton({ limit: MAX_CALENDAR_LIMIT + 1 }), /limit/i);
  assert.throws(() => buildCalendarReadSkeleton({ limit: 3.5 }), /limit/i);
  assert.throws(() => buildCalendarReadSkeleton({ limit: 'ten' }), /limit/i);
});

test('nodes are connected manual -> calendar and structurally complete', () => {
  const wf = buildCalendarReadSkeleton();
  for (const n of wf.nodes) {
    assert.ok(n.id && n.name && n.type && n.position && n.parameters);
  }
  const trig = wf.nodes.find((n) => n.type === 'n8n-nodes-base.manualTrigger');
  assert.ok(wf.connections[trig.name].main[0][0].node === wf.nodes.find((n) => n.type === CALENDAR_NODE_TYPE).name);
});

test('no secret-shaped field appears anywhere in the skeleton', () => {
  const wf = buildCalendarReadSkeleton({ credentialName: 'Google Calendar account (connect your own)' });
  const cal = wf.nodes.find((n) => n.type === CALENDAR_NODE_TYPE);
  assert.equal(cal.credentials[CALENDAR_CRED_TYPE].id, ''); // never a real id
  for (const s of walkStrings(wf)) assert.equal(SECRET_PATTERNS.test(s), false, `secret-shaped string leaked: ${s}`);
});

test('manifest is disclosure-only: type/status, no value, inactive-draft disposition', () => {
  const m = buildCalendarReadManifest({ calendar: '' });
  assert.equal(m.version, 'setup_manifest/v1');
  assert.equal(m.status, 'setup_required');
  assert.equal(m.createDisposition, 'create_inactive_draft'); // v1 always inactive draft
  assert.equal(m.credentialRequirements.length, 1);
  const req = m.credentialRequirements[0];
  assert.deepEqual(Object.keys(req).sort(), ['boundName', 'credentialType', 'displayName', 'nodeIds', 'status', 'whyNeeded'].sort());
  assert.equal(req.credentialType, CALENDAR_CRED_TYPE);
  assert.equal(req.boundName, null);
  assert.equal(req.status, 'setup_required');
  for (const s of walkStrings(m)) assert.equal(SECRET_PATTERNS.test(s), false, `secret-shaped string in manifest: ${s}`);
});

test('manifest config status reflects calendar selection', () => {
  assert.equal(buildCalendarReadManifest({ calendar: '' }).configurationRequirements[0].status, 'unset');
  assert.equal(buildCalendarReadManifest({ calendar: 'primary' }).configurationRequirements[0].status, 'set');
});

test('skill metadata is solo-only, read-only, credentialed', () => {
  assert.equal(SOLO_CALENDAR_SKILL.soloOnly, true);
  assert.equal(SOLO_CALENDAR_SKILL.risk, 'read_only');
  assert.deepEqual(SOLO_CALENDAR_SKILL.credentialRequirements, [CALENDAR_CRED_TYPE]);
});
