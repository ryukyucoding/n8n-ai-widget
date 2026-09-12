'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrivateTopologyReport, validatePrivateTopologyReport } = require('./privateTopologyReport');

const passing = {
  service: { running: true, revisionPresent: true },
  proxy: { dedicatedRoutePresent: true, upstreamTargetsDesignatedChatbot: true, routeScope: 'dedicated_only', directBypass: 'denied' },
  reachability: { approvedOperatorPath: 'reachable', outsidePath: 'denied', publicChatUnchanged: 'yes' },
  evidenceRefs: ['a2a/topology/perimeter.md'],
};

test('all nine pass conditions produce a verified_private report', () => {
  const report = buildPrivateTopologyReport(passing);
  assert.equal(report.status, 'verified_private');
  assert.doesNotThrow(() => validatePrivateTopologyReport(report));
});

test('missing or false pass conditions remain blocked or candidate, never verified', () => {
  const cases = [
    { service: { running: false, revisionPresent: true } },
    { proxy: { ...passing.proxy, dedicatedRoutePresent: false } },
    { proxy: { ...passing.proxy, upstreamTargetsDesignatedChatbot: false } },
    { proxy: { ...passing.proxy, routeScope: 'broad_or_unknown' } },
    { proxy: { ...passing.proxy, directBypass: 'reachable' } },
    { reachability: { ...passing.reachability, approvedOperatorPath: 'denied' } },
    { reachability: { ...passing.reachability, outsidePath: 'reachable' } },
    { reachability: { ...passing.reachability, publicChatUnchanged: 'no' } },
    { evidenceRefs: [] },
  ];
  for (const patch of cases) {
    const report = buildPrivateTopologyReport({ ...passing, ...patch });
    assert.notEqual(report.status, 'verified_private');
  }
});

test('candidate_private is only allowed with dedicated route and denied bypass', () => {
  const report = buildPrivateTopologyReport({ ...passing, reachability: { ...passing.reachability, publicChatUnchanged: 'unknown' } });
  assert.equal(report.status, 'candidate_private');
  assert.doesNotThrow(() => validatePrivateTopologyReport(report));
  assert.throws(() => validatePrivateTopologyReport({ ...report, proxy: { ...report.proxy, directBypass: 'unknown' } }), /candidate private/);
});

test('public outside reachability cannot be marked ready', () => {
  const report = buildPrivateTopologyReport({ ...passing, reachability: { ...passing.reachability, outsidePath: 'reachable' } });
  assert.equal(report.status, 'blocked');
  assert.throws(() => validatePrivateTopologyReport({ ...report, status: 'verified_private' }), /all pass|publicly reachable/);
});

test('ambiguous target or broad route scope is rejected', () => {
  const report = buildPrivateTopologyReport({ ...passing, proxy: { ...passing.proxy, routeScope: 'broad_or_unknown' } });
  assert.equal(report.status, 'blocked');
  assert.throws(() => validatePrivateTopologyReport({ ...report, status: 'verified_private' }), /all pass/);
  assert.throws(() => validatePrivateTopologyReport({ ...buildPrivateTopologyReport(passing), target: 'chatbot-1' }), /target/);
});

test('forbidden topology identifiers, URLs, CIDRs, and secrets never pass disclosure validation', () => {
  const report = buildPrivateTopologyReport({ ...passing, stopReasons: ['10.0.0.0/8', 'https://private.example', 'use token sk-secret-token'] });
  assert.equal(report.stopReasons.length, 0);
  assert.throws(() => validatePrivateTopologyReport({ ...buildPrivateTopologyReport(passing), evidenceRefs: ['10.0.0.1/path'] }), /evidence refs/);
});

test('validator rejects unknown fields and malformed evidence refs', () => {
  const report = buildPrivateTopologyReport(passing);
  assert.throws(() => validatePrivateTopologyReport({ ...report, containerName: 'other-service' }), /forbidden/);
  assert.throws(() => validatePrivateTopologyReport({ ...report, evidenceRefs: ['../raw.log'] }), /evidence refs/);
});
