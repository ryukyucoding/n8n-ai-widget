'use strict';

// Browser-safe setup disclosure. This module deliberately projects from a
// resolver result instead of copying it. Handles, ids, tokens, values, and
// private credential metadata stay server-side.

const MAX_TEXT = 256;
const MAX_ITEMS = 50;
const STATUSES = new Set(['resolved', 'ready', 'setup_required', 'needs_choice', 'stale', 'unauthenticated', 'set', 'unset']);
const SECRET_SHAPED = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|\bbearer\s+[A-Za-z0-9._-]{8,}\b|\b(?:sk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{8,}\b|\b[A-Fa-f0-9]{40,}\b|[A-Za-z0-9+/]{80,}={0,2}/i;

function text(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEXT || SECRET_SHAPED.test(trimmed)) return fallback;
  return trimmed;
}

function status(value, fallback) {
  return STATUSES.has(value) ? value : fallback;
}

function stringList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => typeof item === 'string' && item.trim() && item.length <= MAX_TEXT)
    .map((item) => item.trim()).slice(0, MAX_ITEMS);
}

function candidateCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000 ? value : undefined;
}

function projectCredentialRequirement(requirement = {}) {
  const out = {};
  const credentialType = text(requirement.credentialType);
  if (!credentialType) return null;
  out.credentialType = credentialType;
  const displayName = text(requirement.displayName);
  const whyNeeded = text(requirement.whyNeeded);
  const selectedDisplayName = text(requirement.selectedDisplayName);
  if (displayName) out.displayName = displayName;
  if (whyNeeded) out.whyNeeded = whyNeeded;
  out.status = status(requirement.status, 'setup_required');
  const nodeIds = stringList(requirement.nodeIds);
  if (nodeIds) out.nodeIds = nodeIds;
  const count = candidateCount(requirement.candidateCount);
  if (count !== undefined) out.candidateCount = count;
  if (selectedDisplayName) out.selectedDisplayName = selectedDisplayName;
  return out;
}

function projectConfigurationRequirement(requirement = {}) {
  const field = text(requirement.field);
  if (!field) return null;
  const out = { field, status: status(requirement.status, 'unset') };
  const displayName = text(requirement.displayName);
  if (displayName) out.displayName = displayName;
  return out;
}

function normalizedStatus(value) {
  return value === 'ready' ? 'resolved' : value;
}

function overallStatus(requirements) {
  if (requirements.some((r) => r.status === 'unauthenticated')) return 'unauthenticated';
  if (requirements.some((r) => r.status === 'stale')) return 'stale';
  if (requirements.some((r) => r.status === 'needs_choice')) return 'needs_choice';
  if (requirements.some((r) => r.status === 'setup_required')) return 'setup_required';
  return 'ready';
}

function buildSetupManifest({ requirements = [], configurationRequirements = [] } = {}) {
  const credentialRequirements = Array.isArray(requirements)
    ? requirements.map(projectCredentialRequirement).filter(Boolean).slice(0, MAX_ITEMS)
    : [];
  for (const requirement of credentialRequirements) requirement.status = normalizedStatus(requirement.status);
  const configuration = Array.isArray(configurationRequirements)
    ? configurationRequirements.map(projectConfigurationRequirement).filter(Boolean).slice(0, MAX_ITEMS)
    : [];
  const statusValue = overallStatus(credentialRequirements);
  const createDisposition = statusValue === 'unauthenticated'
    ? 'review_only'
    : (statusValue === 'ready' ? 'bind_and_create' : 'create_inactive_draft');
  return {
    version: 'setup_manifest/v1',
    status: statusValue,
    createDisposition,
    credentialRequirements,
    configurationRequirements: configuration,
  };
}

module.exports = { buildSetupManifest, projectCredentialRequirement, projectConfigurationRequirement };
