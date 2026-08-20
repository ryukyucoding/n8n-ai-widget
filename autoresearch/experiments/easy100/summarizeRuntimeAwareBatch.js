'use strict';

// Offline aggregate analysis of private runtime-aware candidates. It reports
// only n8n node identities, parameter names, and finding counts -- never the
// prompt, workflow JSON, URL, credential, or parameter value.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEasyCases } = require('./runEasy100Batch');
const { canonicalizeWorkflow } = require('../../agent/canonicalizeWorkflow');
const { getAuthoritativeRepairContext } = require('../../agent/getAuthoritativeRepairContext');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function increment(target, key, count = 1) {
  target[key] = (target[key] || 0) + count;
}

function sortedCounts(counts) {
  return Object.entries(counts).sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey)).map(([key, count]) => ({ key, count }));
}

function safeSignature(findings) {
  return [...new Set((findings || []).map((finding) => typeof finding?.category === 'string' ? finding.category : 'unknown'))].sort().join('+') || 'none';
}

function aggregateFindings(findings, totals) {
  increment(totals.findingSignatures, safeSignature(findings));
  for (const finding of findings || []) {
    const category = typeof finding?.category === 'string' ? finding.category : 'unknown';
    increment(totals.findingCategories, category);
    const context = finding?.repairContext;
    if (!context || typeof context !== 'object') continue;
    if (category === 'parameter_schema' && typeof context.nodeType === 'string') {
      increment(totals.parameterSchemaByNodeType, context.nodeType);
      if (typeof context.parameterName === 'string') increment(totals.parameterSchemaByNodeAndName, `${context.nodeType}.${context.parameterName}`);
    }
    if (category === 'node_type' && typeof context.requiredNodeType === 'string') increment(totals.missingRequiredNodeTypes, context.requiredNodeType);
    if (category === 'node_type' && typeof context.forbiddenNodeType === 'string') increment(totals.forbiddenGeneratedNodeTypes, context.forbiddenNodeType);
  }
}

function summarizeTotals(totals) {
  return {
    findingCategories: sortedCounts(totals.findingCategories),
    findingSignatures: sortedCounts(totals.findingSignatures),
    parameterSchemaByNodeType: sortedCounts(totals.parameterSchemaByNodeType),
    parameterSchemaByNodeAndName: sortedCounts(totals.parameterSchemaByNodeAndName),
    missingRequiredNodeTypes: sortedCounts(totals.missingRequiredNodeTypes),
    forbiddenGeneratedNodeTypes: sortedCounts(totals.forbiddenGeneratedNodeTypes),
  };
}

function summarizeRuntimeAwareBatch({ inputPath, predictionsPath, outputPath, canonicalize = canonicalizeWorkflow, inspect = getAuthoritativeRepairContext } = {}) {
  if (!inputPath || !predictionsPath || !outputPath) throw new TypeError('inputPath, predictionsPath, and outputPath are required');
  const descriptions = new Map(loadEasyCases(inputPath).map((item) => [String(item.caseId), item.description]));
  const predictions = readJsonLines(predictionsPath);
  const totals = {
    findingCategories: {}, findingSignatures: {}, parameterSchemaByNodeType: {}, parameterSchemaByNodeAndName: {}, missingRequiredNodeTypes: {}, forbiddenGeneratedNodeTypes: {},
  };
  let inspectedCandidates = 0;
  let unavailableCandidates = 0;
  for (const entry of predictions) {
    const caseId = String(entry?.id);
    const description = descriptions.get(caseId);
    if (!description || !entry?.predicted || typeof entry.predicted !== 'object') {
      unavailableCandidates += 1;
      continue;
    }
    try {
      const canonical = canonicalize({ workflow: entry.predicted, userRequest: description });
      aggregateFindings(inspect({ workflow: canonical, userRequest: description }), totals);
      inspectedCandidates += 1;
    } catch {
      unavailableCandidates += 1;
    }
  }
  const report = {
    schemaVersion: '1.0',
    kind: 'runtime_aware_easy100_offline_finding_summary',
    executionPolicy: 'no_model_no_n8n_create_or_execution',
    predictionSetFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')),
    inspectedCandidates, unavailableCandidates,
    totals: summarizeTotals(totals),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  try {
    const report = summarizeRuntimeAwareBatch({
      inputPath: process.env.EASY100_INPUT_PATH,
      predictionsPath: process.env.RUNTIME_AWARE_PREDICTIONS_PATH,
      outputPath: process.env.RUNTIME_AWARE_SUMMARY_OUTPUT_PATH,
    });
    process.stdout.write(JSON.stringify({ inspectedCandidates: report.inspectedCandidates, unavailableCandidates: report.unavailableCandidates, findingCategories: report.totals.findingCategories }) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { aggregateFindings, safeSignature, summarizeRuntimeAwareBatch, summarizeTotals };
