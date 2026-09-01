'use strict';

// Offline audit of what may be normalized, what must return to generation,
// and what requires user setup. No workflow content or parameter values leave
// this process.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEasyCases } = require('./runEasy100Batch');
const { canonicalizeWorkflow } = require('../../agent/canonicalizeWorkflow');
const { getAuthoritativeRepairContext } = require('../../agent/getAuthoritativeRepairContext');
const { classifyAuthoritativeFindings } = require('../../agent/runtimeRepairSafetyPolicy');

function sha256(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function readJsonLines(filePath) { return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
function increment(target, key) { target[key] = (target[key] || 0) + 1; }
function sorted(counts) { return Object.entries(counts).sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b)).map(([key, count]) => ({ key, count })); }

function auditRepairSafety({ inputPath, predictionsPath, outputPath, canonicalize = canonicalizeWorkflow, inspect = getAuthoritativeRepairContext, classify = classifyAuthoritativeFindings } = {}) {
  if (!inputPath || !predictionsPath || !outputPath) throw new TypeError('inputPath, predictionsPath, and outputPath are required');
  const descriptions = new Map(loadEasyCases(inputPath).map((item) => [String(item.caseId), item.description]));
  const dispositions = {};
  const migrationActions = {};
  let inspectedCandidates = 0;
  let unavailableCandidates = 0;
  for (const entry of readJsonLines(predictionsPath)) {
    const description = descriptions.get(String(entry?.id));
    if (!description || !entry?.predicted || typeof entry.predicted !== 'object') { unavailableCandidates += 1; continue; }
    try {
      const workflow = canonicalize({ workflow: entry.predicted, userRequest: description });
      const result = classify({ workflow, findings: inspect({ workflow, userRequest: description }) });
      for (const item of result.classifications) increment(dispositions, item.disposition);
      for (const action of result.migrationActions) increment(migrationActions, action);
      inspectedCandidates += 1;
    } catch { unavailableCandidates += 1; }
  }
  const report = { schemaVersion: '1.0', kind: 'easy100_repair_safety_audit', executionPolicy: 'no_model_no_n8n_create_or_execution', predictionSetFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')), inspectedCandidates, unavailableCandidates, dispositions: sorted(dispositions), knownMigrationActions: sorted(migrationActions) };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  try {
    const report = auditRepairSafety({ inputPath: process.env.EASY100_INPUT_PATH, predictionsPath: process.env.RUNTIME_AWARE_PREDICTIONS_PATH, outputPath: process.env.REPAIR_SAFETY_AUDIT_OUTPUT_PATH });
    process.stdout.write(JSON.stringify({ inspectedCandidates: report.inspectedCandidates, unavailableCandidates: report.unavailableCandidates, dispositions: report.dispositions }) + '\n');
  } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; }
}

module.exports = { auditRepairSafety };
