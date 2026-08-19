'use strict';

// Reads one saved candidate in memory and writes only the validator's safe
// repair context. It never calls a model, n8n, or an execution endpoint.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { loadCandidate } = require('./runSavedMechanicalRepairTrial');
const { getAuthoritativeRepairContext } = require('../../agent/getAuthoritativeRepairContext');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function inspectSavedAuthoritativeRepairContext({ inputPath, predictionsPath, outputPath, caseId = '2', inspect = getAuthoritativeRepairContext } = {}) {
  if (!inputPath || !predictionsPath || !outputPath) throw new TypeError('inputPath, predictionsPath, and outputPath are required');
  const candidate = loadCandidate({ inputPath, predictionsPath, caseId });
  const findings = inspect({ workflow: candidate.workflow, userRequest: candidate.description });
  const report = {
    schemaVersion: '1.0',
    kind: 'easy100_authoritative_repair_context',
    executionPolicy: 'no_model_no_n8n_create_or_execution',
    caseId: String(caseId),
    findingCount: findings.length,
    findings,
    predictionSetFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')),
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  try {
    const report = inspectSavedAuthoritativeRepairContext({
      inputPath: process.env.EASY100_INPUT_PATH,
      predictionsPath: process.env.EASY100_PREDICTIONS_PATH,
      outputPath: process.env.EASY100_REPAIR_CONTEXT_OUTPUT_PATH,
      caseId: process.env.EASY100_REPAIR_CASE_ID || '2',
    });
    process.stdout.write(JSON.stringify({ caseId: report.caseId, findingCount: report.findingCount }) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { inspectSavedAuthoritativeRepairContext };
