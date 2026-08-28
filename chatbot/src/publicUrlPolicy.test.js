'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePublicHttpsUrl } = require('./publicUrlPolicy');

test('allows the current public fixture host over default HTTPS', () => {
  assert.equal(validatePublicHttpsUrl('https://jsonplaceholder.typicode.com/users/1'), 'https://jsonplaceholder.typicode.com/users/1');
});

test('rejects metadata, private, loopback, local, and unapproved hosts', () => {
  for (const value of [
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/',
    'https://127.0.0.1:5678/api/v1/credentials',
    'https://localhost/',
    'https://service.local/',
    'https://example.com/',
  ]) {
    assert.throws(() => validatePublicHttpsUrl(value));
  }
});

test('rejects userinfo, non-default ports, and non-HTTPS URLs', () => {
  for (const value of [
    'https://token@example.com/',
    'https://jsonplaceholder.typicode.com:8443/users/1',
    'http://jsonplaceholder.typicode.com/users/1',
  ]) {
    assert.throws(() => validatePublicHttpsUrl(value));
  }
});
