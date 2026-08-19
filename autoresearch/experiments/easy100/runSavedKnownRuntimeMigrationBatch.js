'use strict';

// Revalidate every already-saved parseable candidate after the two proven,
// value-preserving runtime migrations. No model, n8n API, or execution is used.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEasyCases, verifyStatic } = require('./runEasy100Batch');
const { canonicalizeWorkflow } = require('../../agent/canonicalizeWorkflow');
const { getAuthoritativeRepairContext } = require('../../agent/getAuthoritativeRepairContext');
const { applyKnownRuntimeMigrations } = require('../../agent/applyKnownRuntimeMigrations');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function countCategories(findings) {
  const counts = {};
  for (const finding of findings || []) {
    const category = typeof finding?.category === 'string' ? finding.category : 'unknown';
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

function incrementAll(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] || 0) + value;
}

function summarizeActions(migration) {
  return (migration?.actions || []).map((action) => ({
    kind: typeof action?.kind === 'string' ? action.kind : 'unknown',
    nodeIndex: Number.isInteger(action?.nodeIndex) ? action.nodeIndex : null,
    nodeType: typeof action?.nodeType === 'string' ? action.nodeType : null,
  }));
}

async function runSavedKnownRuntimeMigrationBatch({ inputPath, predictionsPath, outputPath, canonicalize = canonicalizeWorkflow, inspect = getAuthoritativeRepairContext, migrate = applyKnownRuntimeMigrations, verify = verifyStatic } = {}) {
  if (!inputPath || !predictionsPath || !outputPath) throw new TypeError('inputPath, predictionsPath, and outputPath are required');
  const descriptions = new Map(loadEasyCases(inputPath).map((item) => [String(item.caseId), item.description]));
  const predictions = fs.readFileSync(predictionsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const records = [];

  for (const prediction of predictions) {
    const caseId = String(prediction?.id);
    const description = descriptions.get(caseId);
    if (!description || !prediction?.predicted || typeof prediction.predicted !== 'object') continue;
    try {
      const workflow = canonicalize({ workflow: prediction.predicted, userRequest: description });
      const initialFindings = inspect({ workflow, userRequest: description });
      const migration = migrate(workflow, initialFindings);
      let verification;
      try {
        verification = await verify(workflow, description);
      } catch {
        verification = { status: 'repair' };
      }
      const finalFindings = inspect({ workflow, userRequest: description });
      const staticPass = (verification.status === 'pass' || verification.status === 'warning') && finalFindings.length === 0;
      records.push({
        caseId,
        outcome: staticPass ? 'static_pass' : 'static_blocked',
        initialFindingCategories: countCategories(initialFindings),
        finalFindingCategories: countCategories(finalFindings),
        migrationActions: summarizeActions(migration),
      });
    } catch {
      records.push({ caseId, outcome: 'canonicalization_or_validation_unavailable', initialFindingCategories: {}, finalFindingCategories: {}, migrationActions: [] });
    }
  }

  const finalFindingCategories = {};
  const migrationActionKinds = {};
  for (const record of records) {
    incrementAll(finalFindingCategories, record.finalFindingCategories);
    for (const action of record.migrationActions) migrationActionKinds[action.kind] = (migrationActionKinds[action.kind] || 0) + 1;
  }
  const report = {
    schemaVersion: '1.0',
    kind: 'easy100_saved_known_runtime_migration_batch',
    executionPolicy: 'no_model_no_n8n_execution',
    predictionSetFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')),
    checked: records.length,
    staticPass: records.filter((record) => record.outcome === 'static_pass').length,
    staticBlocked: records.filter((record) => record.outcome === 'static_blocked').length,
    unavailable: records.filter((record) => record.outcome === 'canonicalization_or_validation_unavailable').length,
    finalFindingCategories,
    migrationActionKinds,
    records,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  runSavedKnownRuntimeMigrationBatch({
    inputPath: process.env.EASY100_INPUT_PATH,
    predictionsPath: process.env.EASY100_PREDICTIONS_PATH,
    outputPath: process.env.EASY100_MIGRATION_BATCH_OUTPUT_PATH,
  }).then((report) => process.stdout.write(JSON.stringify({ checked: report.checked, staticPass: report.staticPass, staticBlocked: report.staticBlocked, unavailable: report.unavailable, finalFindingCategories: report.finalFindingCategories, migrationActionKinds: report.migrationActionKinds }) + '\n')).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

module.exports = { countCategories, runSavedKnownRuntimeMigrationBatch, summarizeActions };
