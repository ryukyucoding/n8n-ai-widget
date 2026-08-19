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

function summarizeRepairContext(context) {
  if (Number.isInteger(context?.nodeIndex) && typeof context.nodeType === 'string' && typeof context.parameterName === 'string') {
    return { nodeIndex: context.nodeIndex, nodeType: context.nodeType, parameterName: context.parameterName };
  }
  if (Number.isInteger(context?.sourceNodeIndex) && typeof context.sourceNodeType === 'string'
    && typeof context.connectionType === 'string' && Number.isInteger(context.sourceOutputIndex)) {
    const safe = {
      sourceNodeIndex: context.sourceNodeIndex,
      sourceNodeType: context.sourceNodeType,
      connectionType: context.connectionType,
      sourceOutputIndex: context.sourceOutputIndex,
    };
    if (Number.isInteger(context.targetNodeIndex) && typeof context.targetNodeType === 'string' && Number.isInteger(context.targetInputIndex)) {
      safe.targetNodeIndex = context.targetNodeIndex;
      safe.targetNodeType = context.targetNodeType;
      safe.targetInputIndex = context.targetInputIndex;
    }
    return safe;
  }
  return null;
}

function summarizeAuthoritativeFindings(findings) {
  return findings.map((finding) => {
    const summary = {};
    for (const key of ['category', 'severity', 'repairable', 'blocking', 'normalized']) {
      if (Object.hasOwn(finding, key)) summary[key] = finding[key];
    }
    const context = summarizeRepairContext(finding?.repairContext);
    if (context) summary.repairContext = context;
    return summary;
  });
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
    authoritativeInitialFindings: summarizeAuthoritativeFindings(initialFindings),
    authoritativeFinalFindingCount: finalFindings.length,
    authoritativeFinalFindings: summarizeAuthoritativeFindings(finalFindings),
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

module.exports = { runSavedKnownRuntimeMigrationTrial, summarizeAuthoritativeFindings, summarizeRepairContext };
