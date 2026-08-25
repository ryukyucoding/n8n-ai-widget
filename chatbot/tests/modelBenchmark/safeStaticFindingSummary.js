'use strict';

const SAFE_FINDING_CLASSES = Object.freeze([
  'node_type',
  'type_version',
  'parameter_schema',
  'parameter_value',
  'connection_port',
  'connection_shape',
  'code_dataflow',
  'unsupported_metadata',
  'payload_sanitization',
  'unknown_structural',
]);

const DIRECT_CATEGORY_CLASS = Object.freeze({
  node_type: 'node_type',
  type_version: 'type_version',
  parameter_schema: 'parameter_schema',
  parameter_value: 'parameter_value',
  connection_port: 'connection_port',
  connection_shape: 'connection_shape',
  code_dataflow: 'code_dataflow',
  dataflow: 'code_dataflow',
  unsupported_metadata: 'unsupported_metadata',
  payload_sanitization: 'payload_sanitization',
});

const DIRECT_RULE_CLASS = Object.freeze([
  ['benchmark.node_type', 'node_type'],
  ['benchmark.type_version', 'type_version'],
  ['benchmark.parameter_schema', 'parameter_schema'],
  ['benchmark.parameter_value', 'parameter_value'],
  ['benchmark.connection_port', 'connection_port'],
  ['benchmark.connection_shape', 'connection_shape'],
  ['benchmark.code_dataflow', 'code_dataflow'],
  ['benchmark.unsupported_metadata', 'unsupported_metadata'],
  ['benchmark.payload_sanitization', 'payload_sanitization'],
  ['connection.port.', 'connection_port'],
  ['connection.shape.', 'connection_shape'],
  ['dataflow.', 'code_dataflow'],
  ['node_schema.parameter.', 'parameter_schema'],
  ['parameter.schema.', 'parameter_schema'],
  ['parameter.value.', 'parameter_value'],
  ['node_schema.type_version.', 'type_version'],
  ['type_version.', 'type_version'],
  ['node_schema.node_type.', 'node_type'],
  ['node_type.', 'node_type'],
  ['unsupported_metadata.', 'unsupported_metadata'],
  ['payload_sanitization.', 'payload_sanitization'],
]);

function safeSeverity(value) {
  if (value === 'warning') return 'warning';
  if (value === 'repair') return 'repair';
  return 'fail';
}

function directStaticFindingClass(finding) {
  const category = typeof finding?.category === 'string' ? finding.category : '';
  if (Object.hasOwn(DIRECT_CATEGORY_CLASS, category)) return DIRECT_CATEGORY_CLASS[category];
  const locationKind = typeof finding?.location?.kind === 'string' ? finding.location.kind : '';
  if (Object.hasOwn(DIRECT_CATEGORY_CLASS, locationKind)) return DIRECT_CATEGORY_CLASS[locationKind];
  const ruleId = typeof finding?.ruleId === 'string' ? finding.ruleId : '';
  for (const [prefix, kind] of DIRECT_RULE_CLASS) {
    if (ruleId.startsWith(prefix)) return kind;
  }
  return null;
}

function classifyStaticFinding(finding) {
  return directStaticFindingClass(finding) || 'unknown_structural';
}

function safeStructuredFinding(finding) {
  const kind = directStaticFindingClass(finding);
  if (!kind) return null;
  return {
    ruleId: `benchmark.${kind}`,
    severity: finding?.severity === 'fail' ? 'fatal' : safeSeverity(finding?.severity),
    evidenceSource: 'runtime_schema',
    category: kind === 'connection_port' || kind === 'connection_shape'
      ? 'connection'
      : (kind === 'code_dataflow' ? 'dataflow' : 'node_schema'),
    repairable: finding?.repairable === true,
    normalized: finding?.normalized === true,
    blocking: finding?.blocking === true,
  };
}

function emptyBucket() {
  return {
    count: 0,
    severity: null,
    severityCounts: { warning: 0, repair: 0, fail: 0 },
    deterministicNormalization: 'not_observed',
    normalizedCount: 0,
    repairableCount: 0,
    repairable: false,
    blocking: false,
    blockingCount: 0,
  };
}

function emptyStaticFindingSummary() {
  return Object.fromEntries(SAFE_FINDING_CLASSES.map((kind) => [kind, emptyBucket()]));
}

function finalizeBucket(bucket) {
  if (!bucket.count) return bucket;
  bucket.severity = ['fail', 'repair', 'warning'].find((severity) => bucket.severityCounts[severity] > 0) || null;
  bucket.deterministicNormalization = bucket.normalizedCount === 0
    ? 'not_applied'
    : (bucket.normalizedCount === bucket.count ? 'fully_resolved' : 'partially_resolved');
  bucket.repairable = bucket.repairableCount > 0;
  bucket.blocking = bucket.blockingCount > 0;
  return bucket;
}

function isBlockingFinding(finding, severity) {
  if (finding?.normalized === true) return false;
  return severity === 'repair' || severity === 'fail';
}

function summarizeStaticFindings(findings) {
  const summary = emptyStaticFindingSummary();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const kind = classifyStaticFinding(finding);
    const bucket = summary[kind];
    const severity = safeSeverity(finding?.severity);
    bucket.count += 1;
    bucket.severityCounts[severity] += 1;
    if (finding?.normalized === true) bucket.normalizedCount += 1;
    if (finding?.repairable === true) bucket.repairableCount += 1;
    if (isBlockingFinding(finding, severity)) bucket.blockingCount += 1;
  }
  return Object.fromEntries(SAFE_FINDING_CLASSES.map((kind) => [kind, finalizeBucket(summary[kind])]));
}

function mergeStaticFindingSummaries(summaries) {
  const merged = emptyStaticFindingSummary();
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    for (const kind of SAFE_FINDING_CLASSES) {
      const source = summary?.[kind];
      if (!source || !Number.isInteger(source.count) || source.count < 1) continue;
      const target = merged[kind];
      target.count += source.count;
      target.normalizedCount += Number.isInteger(source.normalizedCount) ? source.normalizedCount : 0;
      target.repairableCount += Number.isInteger(source.repairableCount) ? source.repairableCount : 0;
      target.blockingCount += Number.isInteger(source.blockingCount) ? source.blockingCount : 0;
      for (const severity of Object.keys(target.severityCounts)) target.severityCounts[severity] += Number.isInteger(source?.severityCounts?.[severity]) ? source.severityCounts[severity] : 0;
    }
  }
  return Object.fromEntries(SAFE_FINDING_CLASSES.map((kind) => [kind, finalizeBucket(merged[kind])]));
}

function summaryFromLegacyCounts(repairFindingCounts) {
  const findings = [];
  for (const [ruleId, count] of Object.entries(repairFindingCounts?.rule || {})) {
    for (let index = 0; index < count; index += 1) findings.push({ ruleId, severity: 'repair', normalized: false });
  }
  return summarizeStaticFindings(findings);
}

module.exports = {
  SAFE_FINDING_CLASSES,
  classifyStaticFinding,
  directStaticFindingClass,
  emptyStaticFindingSummary,
  mergeStaticFindingSummaries,
  safeStructuredFinding,
  summarizeStaticFindings,
  summaryFromLegacyCounts,
};
