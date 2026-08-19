'use strict';

// Tests only two runtime-proven, value-preserving migrations in memory. This
// is not a general generator and never contacts n8n or a model.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { loadCandidate } = require('./runSavedMechanicalRepairTrial');
const { canonicalizeWorkflow } = require('../../agent/canonicalizeWorkflow');
const { getAuthoritativeRepairContext } = require('../../agent/getAuthoritativeRepairContext');
const { applyKnownRuntimeMigrations } = require('../../agent/applyKnownRuntimeMigrations');
const { runRuntimeRepairSkillTrial } = require('../../agent/runRuntimeRepairSkillTrial');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function runSavedKnownRuntimeMigrationTrial({ inputPath, predictionsPath, outputPath, caseId = '2', canonicalize = canonicalizeWorkflow, inspect = getAuthoritativeRepairContext, migrate = applyKnownRuntimeMigrations, verifyTrial = runRuntimeRepairSkillTrial } = {}) {
  if (!inputPath || !predictionsPath || !outputPath) throw new TypeError('inputPath, predictionsPath, and outputPath are required');
  const candidate = loadCandidate({ inputPath, predictionsPath, caseId });
  const workflow = canonicalize({ workflow: candidate.workflow, userRequest: candidate.description });
  const initialFindings = inspect({ workflow, userRequest: candidate.description });
  const migration = migrate(workflow, initialFindings);
  const verification = await verifyTrial({ outputPath, workflow, userRequest: candidate.description, maxToolRounds: 0 });
  const finalFindings = inspect({ workflow, userRequest: candidate.description });
  const report = {
    ...verification,
    kind: 'easy100_known_runtime_migration_trial',
    caseId: String(caseId),
    authoritativeInitialFindingCount: initialFindings.length,
    authoritativeFinalFindingCount: finalFindings.length,
    migration,
    predictionSetFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')),
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  runSavedKnownRuntimeMigrationTrial({
    inputPath: process.env.EASY100_INPUT_PATH,
    predictionsPath: process.env.EASY100_PREDICTIONS_PATH,
    outputPath: process.env.EASY100_MIGRATION_OUTPUT_PATH,
    caseId: process.env.EASY100_REPAIR_CASE_ID || '2',
  }).then((report) => process.stdout.write(JSON.stringify({ outcome: report.outcome, authoritativeFinalFindingCount: report.authoritativeFinalFindingCount, migration: report.migration }) + '\n')).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

module.exports = { runSavedKnownRuntimeMigrationTrial };
