'use strict';

// A static pass is not enough to justify deleting a field. This policy keeps
// automatic repair limited to named, value-preserving migrations.

const { applyKnownRuntimeMigrations } = require('./applyKnownRuntimeMigrations');

const USER_SETUP_PATTERN = /(?:credential|auth|token|api[_-]?key|client[_-]?id|secret|channel|folder|drive|database|recipient|\bto\b|from|account|modelid)/i;
const SEMANTIC_REGENERATION_PATTERN = /(?:prompt|message|subject|body|text|title|instruction|query|content|html|field|fields|values|operation|resource|name)/i;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function dispositionForParameter(parameterName) {
  const name = String(parameterName || '');
  if (USER_SETUP_PATTERN.test(name)) return 'requires_user_setup';
  if (SEMANTIC_REGENERATION_PATTERN.test(name)) return 'semantic_regeneration_required';
  return 'manual_review_required';
}

function classifyAuthoritativeFindings({ workflow, findings, migrate = applyKnownRuntimeMigrations } = {}) {
  const migrationCandidate = clone(workflow || {});
  const migration = migrate(migrationCandidate, findings || []);
  const migratedNodes = new Set((migration.actions || []).map((action) => action.nodeIndex));
  const classifications = [];

  for (const finding of findings || []) {
    const context = finding?.repairContext || {};
    const category = finding?.category;
    let disposition = 'manual_review_required';
    if (category === 'parameter_schema' && migratedNodes.has(context.nodeIndex)) disposition = 'known_runtime_migration';
    else if (category === 'parameter_schema') disposition = dispositionForParameter(context.parameterName);
    else if (category === 'node_type') disposition = 'semantic_regeneration_required';
    else if (category === 'connection_port' || category === 'type_version') disposition = 'deterministic_normalization_candidate';
    else if (category === 'parameter_value') disposition = 'semantic_regeneration_required';
    classifications.push({ category: typeof category === 'string' ? category : 'unknown', disposition });
  }
  return { classifications, migrationActions: (migration.actions || []).map((action) => action.kind), migrationBlocked: (migration.blocked || []).map((item) => item.kind) };
}

function canAutomaticallyRemoveParameter() {
  return false;
}

module.exports = { canAutomaticallyRemoveParameter, classifyAuthoritativeFindings, dispositionForParameter };
