'use strict';

// Re-check saved, already-generated candidates with the benchmark-safe static
// protocol. It never invokes a model, n8n, or an execution.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { findingCategoryCounts, loadEasyCases, readinessFrom, safeCapabilitySummary, verifyStatic } = require('./runEasy100Batch');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function main() {
  const inputPath = process.env.EASY100_INPUT_PATH;
  const predictionsPath = process.env.EASY100_PREDICTIONS_PATH;
  const outputPath = process.env.EASY100_REVERIFY_OUTPUT_PATH;
  if (!inputPath || !predictionsPath || !outputPath) throw new Error('EASY100_INPUT_PATH, EASY100_PREDICTIONS_PATH, and EASY100_REVERIFY_OUTPUT_PATH are required');

  const descriptions = new Map(loadEasyCases(inputPath).map((item) => [item.caseId, item.description]));
  const records = fs.readFileSync(predictionsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const results = [];
  for (const record of records) {
    const description = descriptions.get(String(record.id));
    if (!description || !record.predicted || typeof record.predicted !== 'object') continue;
    const verification = await verifyStatic(record.predicted, description);
    const capability = safeCapabilitySummary(record.predicted);
    results.push({
      caseId: String(record.id),
      staticStatus: verification.status,
      findingCategories: findingCategoryCounts(verification),
      capability,
      executionReadiness: readinessFrom({ parsed: { ok: true }, verification, capability }).category,
    });
  }
  const findings = {};
  for (const result of results) for (const [category, count] of Object.entries(result.findingCategories)) findings[category] = (findings[category] || 0) + count;
  const report = {
    schemaVersion: '1.0', kind: 'easy100_saved_prediction_static_reverification',
    executionPolicy: 'no_model_no_n8n_execution',
    predictionInputFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')),
    checked: results.length,
    staticPass: results.filter((result) => result.staticStatus === 'pass' || result.staticStatus === 'warning').length,
    findingCategories: findings,
    records: results,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(JSON.stringify({ checked: report.checked, staticPass: report.staticPass, findingCategories: report.findingCategories }) + '\n');
}

main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
