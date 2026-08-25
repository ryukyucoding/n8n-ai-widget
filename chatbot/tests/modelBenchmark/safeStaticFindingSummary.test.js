'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SAFE_FINDING_CLASSES, summarizeStaticFindings } = require('./safeStaticFindingSummary');

test('deterministically normalized warning is not blocking', () => {
  const summary = summarizeStaticFindings([{ ruleId: 'connection.port.target_input.normalized', severity: 'warning', normalized: true }]);
  assert.deepEqual(summary.connection_port, {
    count: 1,
    severity: 'warning',
    severityCounts: { warning: 1, repair: 0, fail: 0 },
    deterministicNormalization: 'fully_resolved',
    normalizedCount: 1,
    repairableCount: 0,
    repairable: false,
    blocking: false,
    blockingCount: 0,
  });
});

test('repairable parameter schema and value findings remain blocking before repair', () => {
  const summary = summarizeStaticFindings([
    { ruleId: 'parameter.schema.invalid', severity: 'repair', repairable: true },
    { ruleId: 'parameter.value.invalid', severity: 'repair', repairable: true },
  ]);
  assert.equal(summary.parameter_schema.blocking, true);
  assert.equal(summary.parameter_value.blockingCount, 1);
  assert.equal(summary.parameter_schema.deterministicNormalization, 'not_applied');
  assert.equal(summary.parameter_schema.repairable, true);
  assert.equal(summary.parameter_schema.repairableCount, 1);
});

test('hard structural failures and unknown findings are conservatively classified', () => {
  const summary = summarizeStaticFindings([
    { ruleId: 'node_type.not_supported', severity: 'fatal' },
    { ruleId: 'structural.validation_failed', severity: 'repair' },
  ]);
  assert.equal(summary.node_type.severity, 'fail');
  assert.equal(summary.node_type.blocking, true);
  assert.equal(summary.unknown_structural.severity, 'repair');
  assert.equal(summary.unknown_structural.blocking, true);
});

test('summary retains only fixed classes and cannot reveal workflow detail', () => {
  const summary = summarizeStaticFindings([{ ruleId: 'node.type.invalid', severity: 'repair', location: { nodeName: 'Private Node' }, message: 'private configuration' }]);
  assert.deepEqual(Object.keys(summary), SAFE_FINDING_CLASSES);
  assert.doesNotMatch(JSON.stringify(summary), /Private Node|private configuration|nodeName/i);
});
