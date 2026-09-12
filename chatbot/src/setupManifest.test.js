'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSetupManifest } = require('./setupManifest');

test('setup manifest projects safe public metadata only', () => {
  const manifest = buildSetupManifest({
    requirements: [{
      credentialType: 'googleCalendarOAuth2Api', displayName: 'My Calendar',
      whyNeeded: 'Reads calendar events', status: 'ready', nodeIds: ['cal'],
      candidateCount: 1, selectedDisplayName: 'My Calendar',
      id: 'REAL_ID', handle: 'OPAQUE_HANDLE', token: 'secret', value: 'secret', boundName: 'hidden',
    }],
    configurationRequirements: [{ field: 'calendar', displayName: 'Which calendar', status: 'unset', value: 'private' }],
  });
  assert.deepEqual(manifest, {
    version: 'setup_manifest/v1',
    status: 'ready',
    createDisposition: 'bind_and_create',
    credentialRequirements: [{
      credentialType: 'googleCalendarOAuth2Api', displayName: 'My Calendar',
      whyNeeded: 'Reads calendar events', status: 'resolved', nodeIds: ['cal'],
      candidateCount: 1, selectedDisplayName: 'My Calendar',
    }],
    configurationRequirements: [{ field: 'calendar', displayName: 'Which calendar', status: 'unset' }],
  });
  const json = JSON.stringify(manifest);
  assert.doesNotMatch(json, /REAL_ID|OPAQUE_HANDLE|secret|private|boundName/);
});

test('missing credentials produce an inactive-draft disclosure', () => {
  const manifest = buildSetupManifest({ requirements: [{
    credentialType: 'gmailOAuth2', displayName: 'Gmail account', status: 'setup_required', candidateCount: 0,
  }] });
  assert.equal(manifest.status, 'setup_required');
  assert.equal(manifest.createDisposition, 'create_inactive_draft');
});

test('multiple candidates remain a choice and never expose handles', () => {
  const manifest = buildSetupManifest({ requirements: [{
    credentialType: 'gmailOAuth2', displayName: 'Gmail account', status: 'needs_choice',
    candidateCount: 2, selectedDisplayName: 'Recent Gmail', handle: 'h1', candidates: [{ handle: 'h1' }],
  }] });
  assert.equal(manifest.status, 'setup_required');
  assert.equal(manifest.credentialRequirements[0].candidateCount, 2);
  assert.equal(manifest.credentialRequirements[0].selectedDisplayName, 'Recent Gmail');
  assert.doesNotMatch(JSON.stringify(manifest), /h1|candidates/);
});

test('unauthenticated takes precedence and prevents any n8n create', () => {
  const manifest = buildSetupManifest({ requirements: [
    { credentialType: 'a', status: 'setup_required' },
    { credentialType: 'b', status: 'unauthenticated' },
  ] });
  assert.equal(manifest.status, 'unauthenticated');
  assert.equal(manifest.createDisposition, 'review_only');
});

test('stale takes precedence and forces an inactive disposition', () => {
  const manifest = buildSetupManifest({ requirements: [
    { credentialType: 'a', status: 'ready' },
    { credentialType: 'b', status: 'stale' },
    { credentialType: 'c', status: 'needs_choice' },
  ] });
  assert.equal(manifest.status, 'stale');
  assert.equal(manifest.createDisposition, 'create_inactive_draft');
});

test('UUID-shaped display metadata is not treated as a secret by itself', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const manifest = buildSetupManifest({ requirements: [{
    credentialType: 'x', displayName: uuid, status: 'ready',
  }] });
  assert.equal(manifest.credentialRequirements[0].displayName, uuid);
});
