'use strict';

// Fake-only server-side credential seam for Stage 4. It is intentionally not
// wired into production. Raw records may contain test-only ownership/secret
// fields, but the lister and binder never return those fields to callers.

const crypto = require('node:crypto');

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function revision(record) {
  return crypto.createHash('sha256').update(stable({
    credentialType: record.credentialType,
    displayName: record.displayName,
    version: record.version || 1,
  })).digest('hex');
}

function createFakeCredentialBinding({ records = [] } = {}) {
  const store = records.map((record) => ({ ...record }));

  function find({ credentialType, handle, callerId, scope }) {
    return store.find((record) => record.credentialType === credentialType
      && record.handle === handle
      && record.owner === callerId
      && (record.scope || null) === (scope || null));
  }

  async function listCandidates(credentialType, { callerId, scope } = {}) {
    if (typeof callerId !== 'string' || !callerId || typeof credentialType !== 'string' || !credentialType) return [];
    return store.filter((record) => record.credentialType === credentialType
      && record.owner === callerId
      && (record.scope || null) === (scope || null)
      && record.stale !== true)
      .map((record) => ({
        handle: record.handle,
        displayName: record.displayName,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      }));
  }

  async function bindCredential({ credentialType, handle, callerId, scope } = {}) {
    if (typeof callerId !== 'string' || !callerId) throw new Error('credential_caller_required');
    const record = find({ credentialType, handle, callerId, scope });
    if (!record) throw new Error('credential_not_found_or_not_owned');
    if (record.stale === true) throw new Error('credential_stale');
    return {
      credentialType,
      status: 'ready',
      displayName: record.displayName,
      bindingRevision: revision(record),
      // Server-only value; never pass this object to publicView/planner.
      serverBinding: { handle: record.handle, credentialName: record.displayName },
    };
  }

  return { listCandidates, bindCredential, _records: store };
}

function credentialApprovalContext(resolution = {}) {
  const entries = (Array.isArray(resolution.requirements) ? resolution.requirements : [])
    .map((requirement) => ({
      credentialType: requirement.credentialType,
      status: requirement.status,
      displayName: requirement.selectedDisplayName || requirement.displayName || null,
      bindingRevision: requirement.bindingRevision || null,
    }))
    .sort((a, b) => `${a.credentialType}:${a.displayName}`.localeCompare(`${b.credentialType}:${b.displayName}`));
  return {
    credentialBindingRevision: crypto.createHash('sha256').update(stable({
      createDisposition: resolution.createDisposition || null,
      entries,
    })).digest('hex'),
  };
}

module.exports = { createFakeCredentialBinding, credentialApprovalContext };
