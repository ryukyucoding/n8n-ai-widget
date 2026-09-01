'use strict';

const { resolveCredentialBindings, resolveSkillRequirements } = require('./runtimeSkillRegistry');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

// This is the boundary between a reviewed plan and the native n8n setup UI.
// It deliberately contains credential identities only, never credential values.
function createSetupManifest({ planFingerprint, skillIds, availableCredentialNames = [], configuration = [] }) {
  assert(typeof planFingerprint === 'string' && planFingerprint.trim(), 'planFingerprint is required');
  assert(Array.isArray(skillIds) && skillIds.length > 0, 'skillIds must be a non-empty array');
  assert(Array.isArray(configuration), 'configuration must be an array');

  const skillRequirements = resolveSkillRequirements(skillIds);
  assert(skillRequirements.available, `cannot create setup manifest for unavailable skills: ${skillRequirements.missing.join(', ')}`);

  const credentialResolution = resolveCredentialBindings(skillIds, availableCredentialNames);
  const configurationByKey = new Map(configuration.map((field) => [field.key, field]));
  const configurationItems = uniqueStrings(credentialResolution.configurationRequirements).map((label) => {
    const field = configurationByKey.get(label);
    return {
      kind: 'configuration',
      key: label,
      status: field && field.value != null && field.value !== '' ? 'resolved' : 'setup_required',
      modelVisibility: 'placeholder_only',
      sensitive: Boolean(field && field.sensitive),
    };
  });
  const credentialItems = credentialResolution.bindings.map((binding) => ({
    kind: 'credential',
    key: binding.requirement,
    status: binding.status,
    bindStrategy: binding.status === 'resolved' ? 'bind_existing' : 'create_or_select_in_n8n',
    modelVisibility: 'never',
    sensitive: true,
  }));
  const items = [...credentialItems, ...configurationItems];
  const unresolved = items.filter((item) => item.status === 'setup_required');

  return {
    schemaVersion: '1.0',
    kind: 'runtime_setup_manifest',
    planFingerprint,
    skillIds: uniqueStrings(skillIds),
    workflowDisposition: credentialResolution.createDisposition === 'create_inactive_draft' || unresolved.length > 0
      ? 'create_inactive_draft'
      : 'ready_to_create',
    items,
    unresolvedCount: unresolved.length,
  };
}

function canExposeToPlanner(manifest) {
  assert(manifest && manifest.kind === 'runtime_setup_manifest', 'runtime setup manifest is required');
  return manifest.items
    .filter((item) => item.modelVisibility === 'placeholder_only')
    .map(({ kind, key, status }) => ({ kind, key, status }));
}

module.exports = { createSetupManifest, canExposeToPlanner };
