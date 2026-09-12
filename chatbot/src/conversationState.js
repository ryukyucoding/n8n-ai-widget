'use strict';

// Server-side conversation state for the conversational plan flow
// (CONVERSATIONAL_PLAN_FLOW_DESIGN §5b). Holds, per conversation: caller binding,
// current plan spec, dialogue history, and resolved credential info. The browser
// only ever receives publicView() — an opaque conversationId + sanitized
// plan/status/credential-requirement summary, never the callerId or selection
// handles. State is caller-bound and TTL-expired. In-memory (single-process /
// solo); a durable store is a later concern. Clock injected for tests.

const crypto = require('node:crypto');
const { sanitizePlanSpec } = require('./planSpecSanitizer');
const { buildSetupManifest } = require('./setupManifest');

function createConversationStore({ now = Date.now, ttlMs = 30 * 60 * 1000 } = {}) {
  const map = new Map();

  function opaqueId() {
    return crypto.randomBytes(18).toString('base64url'); // 24 url-safe chars
  }

  function live(conversationId, callerId) {
    const s = map.get(conversationId);
    if (!s) return null;
    if (s.callerId !== callerId) return null; // caller binding
    if (now() - s.updatedAt > ttlMs) { map.delete(conversationId); return null; } // TTL
    return s;
  }

  function create(callerId) {
    // Require an explicit non-empty caller binding (solo callers pass a fixed
    // sentinel like 'solo'); never create generic state for null/undefined.
    if (typeof callerId !== 'string' || callerId.trim() === '') {
      throw new Error('callerId (non-empty string) is required to create a conversation');
    }
    const conversationId = opaqueId();
    const t = now();
    const state = {
      conversationId, callerId,
      status: 'planning',
      planSpec: null,
      history: [],
      credentials: null,
      setupManifest: null,
      createdAt: t, updatedAt: t,
    };
    map.set(conversationId, state);
    return { conversationId, state };
  }

  function get(conversationId, callerId) {
    return live(conversationId, callerId);
  }

  function update(conversationId, callerId, patch = {}) {
    const s = map.get(conversationId);
    if (!s || s.callerId !== callerId) throw new Error('conversation not found for caller');
    if (now() - s.updatedAt > ttlMs) { map.delete(conversationId); throw new Error('conversation expired'); }
    for (const key of ['planSpec', 'history', 'credentials', 'setupManifest', 'status']) {
      if (key in patch) s[key] = patch[key];
    }
    s.updatedAt = now();
    return s;
  }

  // Cancel = return from ready_to_confirm to planning, KEEPING plan + history.
  function cancel(conversationId, callerId) {
    return update(conversationId, callerId, { status: 'planning' });
  }

  // Browser-safe projection: opaque id + status + plan + credential requirement
  // summary (type/status only). Never callerId, never selection handles.
  function publicView(conversationId, callerId) {
    const s = live(conversationId, callerId);
    if (!s) return null;
    const reqs = (s.credentials && s.credentials.requirements) || [];
    const view = {
      conversationId: s.conversationId,
      status: s.status,
      planSpec: sanitizePlanSpec(s.planSpec), // deep sanitize before it reaches the browser
      credentials: reqs.map((r) => ({ credentialType: r.credentialType, status: r.status })),
    };
    if (s.setupManifest) {
      view.setupManifest = buildSetupManifest({
        requirements: s.setupManifest.credentialRequirements || s.setupManifest.requirements || [],
        configurationRequirements: s.setupManifest.configurationRequirements || [],
      });
    }
    return view;
  }

  return { create, get, update, cancel, publicView, _size: () => map.size };
}

module.exports = { createConversationStore };
