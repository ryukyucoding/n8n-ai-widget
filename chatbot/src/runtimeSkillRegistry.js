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
    setupRequirements: ['SMTP credential', 'sender email', 'recipient email'],
    risk: 'external_write',
  },
  {
    id: 'http.authenticated_request',
    label: 'Authenticated HTTP request',
    maturity: 'planned',
    compiler: null,
    requiresUserSetup: true,
    setupRequirements: ['service credential'],
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
  const setupRequirements = [...new Set(requested.flatMap((skill) => skill.setupRequirements || []))];
  const hasExternalWrite = requested.some((skill) => skill.risk === 'external_write');

  return {
    requested: requested.map((skill) => skill.id),
    available: missing.length === 0,
    missing: missing.map((skill) => skill.id),
    setupRequirements,
    requiresConfirmation: hasExternalWrite,
  };
}

module.exports = { SKILLS, getSkill, resolveSkillRequirements };
