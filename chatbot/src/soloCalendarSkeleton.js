'use strict';

// Solo-only Google Calendar read skill — a FIXED, pre-verified n8n skeleton
// created via a dedicated guarded template path, deliberately OUTSIDE the
// nodewise planner/compiler (its output is opaque/unknown-schema and cannot go
// through validateSpecification's field-mapping contract). See
// a2a/skills/SOLO_CALENDAR_READ_DESIGN.md (§2a Option a).
//
// Guard rails enforced here: read-only (event getAll only), credential by-name
// with EMPTY id (Dan attaches his own in n8n), bounded limit, NO timeMin/timeMax,
// no secret ever present. This module is pure (no env, no network).

const CALENDAR_NODE_TYPE = 'n8n-nodes-base.googleCalendar';
const CALENDAR_TYPE_VERSION = 1.3;
const CALENDAR_CRED_TYPE = 'googleCalendarOAuth2Api';
const DEFAULT_CALENDAR_LIMIT = 10;
const MAX_CALENDAR_LIMIT = 100;
const DEFAULT_CREDENTIAL_NAME = 'Google Calendar account (connect your own)';

// Provenance/disclosure metadata, kept SEPARATE from the nodewise runtimeSkillRegistry
// SKILLS array so the compiler's approval-fingerprint / contract surface stays
// completely untouched (faithful to "outside the compiler").
const SOLO_CALENDAR_SKILL = Object.freeze({
  id: 'solo.google_calendar.event_getAll',
  label: 'Google Calendar — list events (read-only, solo)',
  soloOnly: true,
  maturity: 'implemented_solo',
  compiler: 'soloCalendarSkeleton',
  requiresUserSetup: true,
  credentialRequirements: [CALENDAR_CRED_TYPE],
  risk: 'read_only',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validatedLimit(limit) {
  if (limit === undefined) return DEFAULT_CALENDAR_LIMIT;
  assert(Number.isInteger(limit), 'limit must be an integer');
  assert(limit >= 1 && limit <= MAX_CALENDAR_LIMIT, `limit must be between 1 and ${MAX_CALENDAR_LIMIT}`);
  return limit;
}

// Build the fixed Calendar read skeleton. Never sets timeMin/timeMax; supplying
// them is a hard error (boundedness is returnAll:false + limit only).
function buildCalendarReadSkeleton(options = {}) {
  assert(options && typeof options === 'object', 'options must be an object');
  assert(!('timeMin' in options) && !('timeMax' in options), 'timeMin/timeMax are not allowed in v1 (bound with limit)');
  const limit = validatedLimit(options.limit);
  const calendar = typeof options.calendar === 'string' ? options.calendar : '';
  const credentialName = typeof options.credentialName === 'string' && options.credentialName.trim()
    ? options.credentialName.trim()
    : DEFAULT_CREDENTIAL_NAME;

  return {
    name: 'Google Calendar (read-only) — list events [solo]',
    active: false, // never auto-activate; Dan connects a credential then activates in n8n
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'trigger',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [240, 300],
        parameters: {},
      },
      {
        id: 'cal',
        name: 'List Calendar Events',
        type: CALENDAR_NODE_TYPE,
        typeVersion: CALENDAR_TYPE_VERSION,
        position: [500, 300],
        parameters: {
          resource: 'event',
          operation: 'getAll',
          calendar: { __rl: true, mode: 'list', value: calendar },
          returnAll: false,
          limit,
          options: {},
        },
        credentials: { [CALENDAR_CRED_TYPE]: { id: '', name: credentialName } },
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'List Calendar Events', type: 'main', index: 0 }]] },
    },
  };
}

// Server-derived setup disclosure (no secret; only credential identity + status).
// v1 always reports create_inactive_draft: the skeleton ships with an empty
// credential id, so the workflow is an inactive draft until Dan connects his own
// credential in n8n and activates it (bind_and_create is deferred — it would
// require querying n8n for an existing credential, an unconfirmed key privilege).
function buildCalendarReadManifest({ calendar = '' } = {}) {
  return {
    version: 'setup_manifest/v1',
    status: 'setup_required',
    createDisposition: 'create_inactive_draft',
    credentialRequirements: [
      {
        credentialType: CALENDAR_CRED_TYPE,
        displayName: 'Google Calendar account',
        whyNeeded: "The 'List Calendar Events' step reads your calendar",
        nodeIds: ['cal'],
        status: 'setup_required',
        boundName: null,
      },
    ],
    configurationRequirements: [
      { field: 'calendar', displayName: 'Which calendar', status: calendar ? 'set' : 'unset' },
    ],
  };
}

module.exports = {
  buildCalendarReadSkeleton,
  buildCalendarReadManifest,
  SOLO_CALENDAR_SKILL,
  CALENDAR_NODE_TYPE,
  CALENDAR_TYPE_VERSION,
  CALENDAR_CRED_TYPE,
  DEFAULT_CALENDAR_LIMIT,
  MAX_CALENDAR_LIMIT,
  DEFAULT_CREDENTIAL_NAME,
};
