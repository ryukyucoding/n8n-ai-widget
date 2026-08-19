'use strict';

// Read saved predictions only in memory and emit a de-identified selection
// report. It never prints or stores a candidate workflow or user description.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { findingCategoryCounts, loadEasyCases, safeCapabilitySummary, verifyStatic } = require('./runEasy100Batch');

const MECHANICAL_CATEGORIES = new Set(['type_version', 'parameter_schema', 'parameter_value']);

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isMechanicalOnly(categories) {
  const names = Object.keys(categories || {});
  return names.length > 0 && names.every((category) => MECHANICAL_CATEGORIES.has(category));
}

async function inspectPrediction({ prediction, description, verify = verifyStatic }) {
  let verification;
  try {
    verification = await verify(prediction, description);
  } catch (error) {
    verification = { status: 'repair', findings: Array.isArray(error?.findings) ? error.findings : [] };
  }
  const findingCategories = findingCategoryCounts(verification);
  return {
    staticStatus: verification?.status || 'repair',
    findingCategories,
    candidateNodeCount: Array.isArray(prediction?.nodes) ? prediction.nodes.length : 0,
    capability: safeCapabilitySummary(prediction),
    eligibleForMechanicalRepairTrial: verification?.status === 'repair' && isMechanicalOnly(findingCategories),
  };
}

async function selectSavedRepairCandidate({ inputPath, predictionsPath, outputPath, verify = verifyStatic }) {
  if (!inputPath || !predictionsPath || !outputPath) throw new TypeError('inputPath, predictionsPath, and outputPath are required');
  const descriptions = new Map(loadEasyCases(inputPath).map((entry) => [String(entry.caseId), entry.description]));
  const predictions = readJsonLines(predictionsPath);
  const records = [];
  for (const entry of predictions) {
    const caseId = String(entry?.id ?? '');
    if (!caseId || !descriptions.has(caseId) || !entry?.predicted || typeof entry.predicted !== 'object') continue;
    const inspected = await inspectPrediction({ prediction: entry.predicted, description: descriptions.get(caseId), verify });
    records.push({ caseId, ...inspected });
  }
  const selected = records.find((record) => record.eligibleForMechanicalRepairTrial) || null;
  const report = {
    schemaVersion: '1.0',
    kind: 'easy100_saved_repair_candidate_selection',
    executionPolicy: 'no_model_no_n8n_create_or_execution',
    predictionSetFingerprint: fingerprint(fs.readFileSync(predictionsPath, 'utf8')),
    inspectedCount: records.length,
    selectedCaseId: selected?.caseId || null,
    selectionReason: selected ? 'mechanical_repair_scope' : 'no_saved_candidate_in_current_mechanical_repair_scope',
    records,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  selectSavedRepairCandidate({
    inputPath: process.env.EASY100_INPUT_PATH,
    predictionsPath: process.env.EASY100_PREDICTIONS_PATH,
    outputPath: process.env.EASY100_SELECTION_OUTPUT_PATH,
  }).then((report) => process.stdout.write(`${JSON.stringify({ inspectedCount: report.inspectedCount, selectedCaseId: report.selectedCaseId, selectionReason: report.selectionReason })}\n`)).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

module.exports = { inspectPrediction, isMechanicalOnly, selectSavedRepairCandidate };
