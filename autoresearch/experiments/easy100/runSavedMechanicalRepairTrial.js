'use strict';

// Runs the bounded repair skill against one already-generated Easy-100
// candidate. The candidate and description remain in memory and are never
// emitted in the report or written back to the prediction set.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEasyCases } = require('./runEasy100Batch');
const { runRuntimeRepairSkillTrial } = require('../../agent/runRuntimeRepairSkillTrial');

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function loadCandidate({ inputPath, predictionsPath, caseId }) {
  const normalizedId = String(caseId);
  const description = new Map(loadEasyCases(inputPath).map((entry) => [String(entry.caseId), entry.description])).get(normalizedId);
  const entry = readJsonLines(predictionsPath).find((item) => String(item?.id) === normalizedId);
  if (!description || !entry?.predicted || typeof entry.predicted !== 'object') throw new Error('saved_candidate_not_available');
  return { description, workflow: entry.predicted };
}

async function runSavedMechanicalRepairTrial({ inputPath, predictionsPath, outputPath, caseId = '2', runTrial = runRuntimeRepairSkillTrial, options = {} } = {}) {
  if (!inputPath || !predictionsPath || !outputPath) throw new TypeError('inputPath, predictionsPath, and outputPath are required');
  const candidate = loadCandidate({ inputPath, predictionsPath, caseId });
  const trial = await runTrial({ ...options, outputPath, workflow: candidate.workflow, userRequest: candidate.description });
  const report = {
    ...trial,
    kind: 'easy100_saved_mechanical_repair_trial',
    caseId: String(caseId),
    predictionSetFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')),
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  runSavedMechanicalRepairTrial({
    inputPath: process.env.EASY100_INPUT_PATH,
    predictionsPath: process.env.EASY100_PREDICTIONS_PATH,
    outputPath: process.env.EASY100_REPAIR_OUTPUT_PATH,
    caseId: process.env.EASY100_REPAIR_CASE_ID || '2',
    options: {
      maxToolRounds: Number.parseInt(process.env.RUNTIME_REPAIR_SKILL_MAX_TOOL_ROUNDS || '4', 10),
    },
  }).then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
}

module.exports = { loadCandidate, runSavedMechanicalRepairTrial };
