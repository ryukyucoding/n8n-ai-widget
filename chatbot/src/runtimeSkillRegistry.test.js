'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getSkill, resolveSkillRequirements } = require('./runtimeSkillRegistry');

test('lists only compiler-owned capabilities as implemented', () => {
  assert.equal(getSkill('http.public_get').maturity, 'implemented');
  assert.equal(getSkill('http.authenticated_request').maturity, 'planned');
});

test('makes credential setup explicit without treating it as a secret value', () => {
  const result = resolveSkillRequirements(['workflow.daily_rss_digest', 'delivery.smtp_email_draft']);
  assert.equal(result.available, true);
  assert.equal(result.requiresConfirmation, true);
  assert.deepEqual(result.setupRequirements, ['SMTP credential', 'sender email', 'recipient email']);
});

test('reports unsupported compiler work instead of silently accepting it', () => {
  const result = resolveSkillRequirements(['http.public_get', 'http.authenticated_request']);
  assert.equal(result.available, false);
  assert.deepEqual(result.missing, ['http.authenticated_request']);
});
