'use strict';

// This module deliberately knows nothing about n8n APIs or workflow nodes. It
// evaluates only externally supplied final item output against declarative
// assertions explicitly retained in an acceptance contract.

const SAFE_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD_ASSERTION_KEYS = new Set(['kind', 'path', 'required', 'expectedType', 'equals', 'minimum', 'maximum']);
const COUNT_ASSERTION_KEYS = new Set(['kind', 'equals', 'minimum', 'maximum']);

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isExecutionAllowed(executionSafety) {
  return executionSafety === true || Boolean(executionSafety && executionSafety.allowed === true);
}

function assertionList(contract) {
  return Array.isArray(contract?.executionAssertions) ? contract.executionAssertions : [];
}

function normalizeItems(executionOutput) {
  const source = Array.isArray(executionOutput) ? executionOutput : [executionOutput];
  if (!source.length || source.some((item) => !item || typeof item !== 'object' || !own(item, 'json') || !item.json || typeof item.json !== 'object' || Array.isArray(item.json))) {
    return null;
  }
  return source.map((item) => item.json);
}

function parsePath(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const segments = path.split('.');
  if (segments.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) return null;
  return segments;
}

function readPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !own(current, segment)) return { present: false, value: undefined };
    current = current[segment];
  }
  return { present: true, value: current };
}

function isJsonData(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonData);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(([key, nested]) => !UNSAFE_PATH_SEGMENTS.has(key) && isJsonData(nested));
}

function assertionIsDeclarative(assertion) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) return false;
  if (!isJsonData(assertion)) return false;
  const kind = assertion.kind || 'field';
  if (kind === 'item_count') {
    if (Object.keys(assertion).some((key) => !COUNT_ASSERTION_KEYS.has(key))) return false;
    return ['equals', 'minimum', 'maximum'].some((key) => own(assertion, key) && typeof assertion[key] === 'number' && Number.isFinite(assertion[key]));
  }
  if (kind !== 'field' || !parsePath(assertion.path)) return false;
  if (Object.keys(assertion).some((key) => !FIELD_ASSERTION_KEYS.has(key))) return false;
  if (own(assertion, 'required') && typeof assertion.required !== 'boolean') return false;
  if (own(assertion, 'expectedType') && !SAFE_TYPES.has(assertion.expectedType)) return false;
  if (['minimum', 'maximum'].some((key) => own(assertion, key) && (typeof assertion[key] !== 'number' || !Number.isFinite(assertion[key])))) return false;
  return ['required', 'expectedType', 'equals', 'minimum', 'maximum'].some((key) => own(assertion, key));
}

function failure({ rule, path, expectedKind, actualKind, message }) {
  return {
    rule,
    category: 'execution_result',
    severity: 'repair',
    path: path || null,
    expectedKind,
    actualKind,
    message,
  };
}

function equalityMatches(actual, expected) {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function numericFailures(assertion, actual, path) {
  const findings = [];
  if (own(assertion, 'minimum') && (typeof actual !== 'number' || actual < assertion.minimum)) {
    findings.push(failure({
      rule: 'execution_assertion.minimum', path, expectedKind: 'number_at_least', actualKind: kindOf(actual),
      message: `Execution output at ${path} does not meet its declared numeric minimum.`,
    }));
  }
  if (own(assertion, 'maximum') && (typeof actual !== 'number' || actual > assertion.maximum)) {
    findings.push(failure({
      rule: 'execution_assertion.maximum', path, expectedKind: 'number_at_most', actualKind: kindOf(actual),
      message: `Execution output at ${path} exceeds its declared numeric maximum.`,
    }));
  }
  return findings;
}

function fieldFailures(assertion, item, itemIndex) {
  const segments = parsePath(assertion.path);
  const path = `items[${itemIndex}].json.${assertion.path}`;
  const result = readPath(item, segments);
  const findings = [];
  if (assertion.required === true && !result.present) {
    findings.push(failure({
      rule: 'execution_assertion.required', path, expectedKind: 'present', actualKind: 'missing',
      message: `Execution output is missing the required field at ${path}.`,
    }));
  }
  if (!result.present) return findings;
  const actualKind = kindOf(result.value);
  if (own(assertion, 'expectedType') && actualKind !== assertion.expectedType) {
    findings.push(failure({
      rule: 'execution_assertion.type', path, expectedKind: assertion.expectedType, actualKind,
      message: `Execution output at ${path} does not have its declared type.`,
    }));
  }
  if (own(assertion, 'equals') && !equalityMatches(result.value, assertion.equals)) {
    findings.push(failure({
      rule: 'execution_assertion.equals', path, expectedKind: 'exact_match', actualKind,
      message: `Execution output at ${path} does not match its explicitly declared value.`,
    }));
  }
  return findings.concat(numericFailures(assertion, result.value, path));
}

function countFailures(assertion, itemCount) {
  return numericFailures(assertion, itemCount, 'items').map((item) => ({
    ...item,
    rule: item.rule.replace('execution_assertion.', 'execution_assertion.item_count_'),
  })).concat(
    own(assertion, 'equals') && itemCount !== assertion.equals
      ? [failure({
        rule: 'execution_assertion.item_count_equals', path: 'items', expectedKind: 'exact_item_count', actualKind: 'number',
        message: 'Execution output item count does not match its declared count.',
      })]
      : [],
  );
}

function summarize(status, assertions, findings, itemCount, contract) {
  return {
    status,
    itemCount: itemCount ?? null,
    assertionCount: assertions.length,
    passedAssertionCount: status === 'pass' ? assertions.length : Math.max(0, assertions.length - findings.length),
    failedAssertionCount: findings.length,
    contractRevision: Number.isInteger(contract?.contractRevision) ? contract.contractRevision : null,
  };
}

/**
 * Verify external final execution output without performing I/O. `field`
 * assertions may declare `path`, `required`, `expectedType`, `equals`,
 * `minimum`, and/or `maximum`; `item_count` declares `equals`, `minimum`, or
 * `maximum`. Field assertions apply to every final output item.
 */
function verifyExecutionOutput({ executionOutput, acceptanceContract, executionSafety } = {}) {
  const assertions = assertionList(acceptanceContract);
  if (!assertions.length) {
    return { status: 'skipped', reason: 'no_execution_assertions', findings: [], summary: summarize('skipped', assertions, [], null, acceptanceContract) };
  }
  if (!isExecutionAllowed(executionSafety)) {
    return { status: 'skipped', reason: 'execution_not_allowed', findings: [], summary: summarize('skipped', assertions, [], null, acceptanceContract) };
  }
  if (!assertions.every(assertionIsDeclarative)) {
    return { status: 'skipped', reason: 'invalid_execution_assertions', findings: [], summary: summarize('skipped', assertions, [], null, acceptanceContract) };
  }
  const items = normalizeItems(executionOutput);
  if (!items) {
    return { status: 'skipped', reason: 'unsafe_execution_output_shape', findings: [], summary: summarize('skipped', assertions, [], null, acceptanceContract) };
  }

  const findings = [];
  for (const assertion of assertions) {
    if ((assertion.kind || 'field') === 'item_count') {
      findings.push(...countFailures(assertion, items.length));
      continue;
    }
    if (!items.length && assertion.required === true) {
      findings.push(failure({
        rule: 'execution_assertion.required', path: 'items', expectedKind: 'non_empty_item_array', actualKind: 'empty_array',
        message: 'Execution output has no items for a required field assertion.',
      }));
      continue;
    }
    items.forEach((item, index) => findings.push(...fieldFailures(assertion, item, index)));
  }
  const status = findings.length ? 'fail' : 'pass';
  return {
    status,
    reason: status === 'pass' ? 'all_execution_assertions_passed' : 'execution_assertions_failed',
    findings: safeClone(findings),
    summary: summarize(status, assertions, findings, items.length, acceptanceContract),
  };
}

module.exports = { verifyExecutionOutput };
