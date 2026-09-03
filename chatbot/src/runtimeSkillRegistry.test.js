'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getSkill, resolveSkillRequirements, resolveCredentialBindings } = require('./runtimeSkillRegistry');

test('lists only compiler-owned capabilities as implemented', () => {
  assert.equal(getSkill('http.public_get').maturity, 'implemented');
  assert.equal(getSkill('http.authenticated_request').maturity, 'planned');
});

test('registers sort_items as an implemented read-only nodewise skill', () => {
  const skill = getSkill('transform.sort_items');
  assert.equal(skill.maturity, 'implemented');
  assert.equal(skill.compiler, 'nodewise');
  assert.equal(skill.risk, 'read_only');
  assert.equal(skill.requiresUserSetup, false);
  const result = resolveSkillRequirements(['transform.sort_items']);
  assert.equal(result.available, true);
  assert.equal(result.requiresConfirmation, false);
});

test('makes credential setup explicit without treating it as a secret value', () => {
  const result = resolveSkillRequirements(['workflow.daily_rss_digest', 'delivery.smtp_email_draft']);
  assert.equal(result.available, true);
  assert.equal(result.requiresConfirmation, true);
  assert.deepEqual(result.credentialRequirements, ['SMTP credential']);
  assert.deepEqual(result.configurationRequirements, ['sender email', 'recipient email']);
});

test('reports unsupported compiler work instead of silently accepting it', () => {
  const result = resolveSkillRequirements(['http.public_get', 'http.authenticated_request']);
  assert.equal(result.available, false);
  assert.deepEqual(result.missing, ['http.authenticated_request']);
});

test('binds a pre-existing credential without exposing its value to the compiler', () => {
  const result = resolveCredentialBindings(['delivery.smtp_email_draft'], ['SMTP credential']);
  assert.equal(result.createDisposition, 'bind_and_create');
  assert.deepEqual(result.unresolvedRequirements, []);
  assert.deepEqual(result.bindings, [{ requirement: 'SMTP credential', status: 'resolved' }]);
  assert.deepEqual(result.configurationRequirements, ['sender email', 'recipient email']);
});

test('creates an inactive draft when a required credential is absent', () => {
  const result = resolveCredentialBindings(['delivery.smtp_email_draft']);
  assert.equal(result.createDisposition, 'create_inactive_draft');
  assert.deepEqual(result.unresolvedRequirements, ['SMTP credential']);
});
