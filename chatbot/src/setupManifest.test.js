'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetupManifest, canExposeToPlanner } = require('./setupManifest');

test('creates an inactive draft checklist without exposing an absent credential', () => {
  const manifest = createSetupManifest({
    planFingerprint: 'plan-a',
    skillIds: ['delivery.smtp_email_draft'],
  });

  assert.equal(manifest.workflowDisposition, 'create_inactive_draft');
  assert.deepEqual(manifest.items[0], {
    kind: 'credential',
    key: 'SMTP credential',
    status: 'setup_required',
    bindStrategy: 'create_or_select_in_n8n',
    modelVisibility: 'never',
    sensitive: true,
  });
  assert.deepEqual(canExposeToPlanner(manifest), [
    { kind: 'configuration', key: 'sender email', status: 'setup_required' },
    { kind: 'configuration', key: 'recipient email', status: 'setup_required' },
  ]);
});

test('binds a named existing credential while keeping it out of planner context', () => {
  const manifest = createSetupManifest({
    planFingerprint: 'plan-b',
    skillIds: ['delivery.smtp_email_draft'],
    availableCredentialNames: ['SMTP credential'],
    configuration: [
      { key: 'sender email', value: 'sender@example.test', sensitive: true },
      { key: 'recipient email', value: 'team@example.test', sensitive: true },
    ],
  });

  assert.equal(manifest.workflowDisposition, 'ready_to_create');
  assert.equal(manifest.unresolvedCount, 0);
  assert.deepEqual(canExposeToPlanner(manifest), [
    { kind: 'configuration', key: 'sender email', status: 'resolved' },
    { kind: 'configuration', key: 'recipient email', status: 'resolved' },
  ]);
});

test('refuses a manifest for a skill the compiler does not own', () => {
  assert.throws(
    () => createSetupManifest({ planFingerprint: 'plan-c', skillIds: ['http.authenticated_request'] }),
    /unavailable skills/,
  );
});
