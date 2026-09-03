'use strict';

// This registry is intentionally declarative. It records what the compiler can
// actually own today, rather than treating every installed n8n node as supported.
const SKILLS = Object.freeze([
  {
    id: 'trigger.manual',
    label: 'Manual trigger',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'http.public_get',
    label: 'Public HTTPS GET',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'transform.select_fields',
    label: 'Select fields from one object',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'transform.count_false_boolean',
    label: 'Count false boolean values',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'transform.join_object_and_count',
    label: 'Join an object with items and count',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'transform.sort_items',
    label: 'Sort an item list by one field ascending or descending',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'transform.remove_duplicates',
    label: 'Remove duplicate items by one field',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'output.one_object',
    label: 'One object output contract',
    maturity: 'implemented',
    compiler: 'nodewise',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'workflow.daily_rss_digest',
    label: 'Scheduled RSS digest',
    maturity: 'implemented_prototype',
    compiler: 'rssDigestCompiler',
    requiresUserSetup: false,
    risk: 'read_only',
  },
  {
    id: 'delivery.smtp_email_draft',
    label: 'SMTP email delivery draft',
    maturity: 'implemented_prototype',
    compiler: 'rssEmailDraftCompiler',
    requiresUserSetup: true,
    credentialRequirements: ['SMTP credential'],
    configurationRequirements: ['sender email', 'recipient email'],
    risk: 'external_write',
  },
  {
    id: 'http.authenticated_request',
    label: 'Authenticated HTTP request',
    maturity: 'planned',
    compiler: null,
    requiresUserSetup: true,
    credentialRequirements: ['service credential'],
    risk: 'external_write',
  },
  {
    id: 'control.flow',
    label: 'General conditional and wait control flow',
    maturity: 'planned',
    compiler: null,
    requiresUserSetup: false,
    risk: 'read_only',
  },
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getSkill(id) {
  const skill = SKILLS.find((candidate) => candidate.id === id);
  assert(skill, `unknown runtime skill: ${id}`);
  return skill;
}

function resolveSkillRequirements(skillIds) {
  assert(Array.isArray(skillIds), 'skillIds must be an array');
  const requested = [...new Set(skillIds)].map(getSkill);
  const missing = requested.filter((skill) => skill.maturity === 'planned');
  const credentialRequirements = [...new Set(requested.flatMap((skill) => skill.credentialRequirements || []))];
  const configurationRequirements = [...new Set(requested.flatMap((skill) => skill.configurationRequirements || []))];
  const hasExternalWrite = requested.some((skill) => skill.risk === 'external_write');

  return {
    requested: requested.map((skill) => skill.id),
    available: missing.length === 0,
    missing: missing.map((skill) => skill.id),
    credentialRequirements,
    configurationRequirements,
    requiresConfirmation: hasExternalWrite,
  };
}

// Credential values never enter the planner or compiler. This function only
// decides whether a named credential can be bound, or whether the created
// workflow must remain an inactive draft until the user sets it up in n8n.
function resolveCredentialBindings(skillIds, availableCredentialNames = []) {
  assert(Array.isArray(availableCredentialNames), 'availableCredentialNames must be an array');
  const requirements = resolveSkillRequirements(skillIds).credentialRequirements;
  const available = new Set(availableCredentialNames.filter((name) => typeof name === 'string').map((name) => name.trim()));
  const bindings = requirements.map((requirement) => ({
    requirement,
    status: available.has(requirement) ? 'resolved' : 'setup_required',
  }));
  const unresolved = bindings.filter((binding) => binding.status === 'setup_required');

  return {
    bindings,
    unresolvedRequirements: unresolved.map((binding) => binding.requirement),
    configurationRequirements: resolveSkillRequirements(skillIds).configurationRequirements,
    createDisposition: unresolved.length === 0 ? 'bind_and_create' : 'create_inactive_draft',
  };
}

module.exports = { SKILLS, getSkill, resolveSkillRequirements, resolveCredentialBindings };
