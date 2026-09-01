'use strict';

// Small, bounded batch for testing the authoritative schema-repair skill on
// saved Easy-100 candidates. This is not generation or n8n execution.

const fs = require('node:fs');
const path = require('node:path');
const { runSavedAuthoritativeSchemaRepairTrial } = require('./runSavedAuthoritativeSchemaRepairTrial');

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function increment(target, source) {
  for (const [key, count] of Object.entries(source || {})) target[key] = (target[key] || 0) + count;
}

function parseCaseIds(value) {
  const ids = String(value || '0,1,2').split(',').map((part) => part.trim()).filter(Boolean);
  if (!ids.length || ids.length > 5 || ids.some((id) => !/^\d+$/.test(id))) throw new TypeError('case IDs must contain one to five numeric IDs');
  return [...new Set(ids)];
}

async function runAuthoritativeSchemaRepairSmoke({ inputPath, predictionsPath, outputDir, caseIds = ['0', '1', '2'], options = {}, runTrial = runSavedAuthoritativeSchemaRepairTrial } = {}) {
  if (!inputPath || !predictionsPath || !outputDir) throw new TypeError('inputPath, predictionsPath, and outputDir are required');
  const records = [];
  for (const caseId of caseIds) {
    const outputPath = path.join(outputDir, 'private', 'skill-reports', `${caseId}.json`);
    const report = await runTrial({ inputPath, predictionsPath, outputPath, caseId, options });
    records.push({
      caseId: String(caseId), outcome: report.outcome, toolCallCount: Number.isInteger(report.toolCallCount) ? report.toolCallCount : 0,
      initial: report.authoritativeInitialFindingCategories || {}, final: report.authoritativeFinalFindingCategories || {},
    });
  }
  const initial = {};
  const final = {};
  for (const record of records) {
    increment(initial, record.initial);
    increment(final, record.final);
  }
  const report = {
    schemaVersion: '1.0', kind: 'easy100_authoritative_schema_repair_smoke', executionPolicy: 'no_n8n_create_or_execution',
    model: options.model || null, caseIds: records.map((record) => record.caseId), records,
    aggregate: { initialFindingCategories: initial, finalFindingCategories: final, staticPass: records.filter((record) => record.outcome === 'static_pass').length, toolCallCount: records.reduce((total, record) => total + record.toolCallCount, 0) },
  };
  atomicWrite(path.join(outputDir, 'authoritative-schema-repair-smoke.json'), report);
  return report;
}

if (require.main === module) {
  try {
    const outputDir = process.env.SCHEMA_REPAIR_OUTPUT_DIR;
    runAuthoritativeSchemaRepairSmoke({
      inputPath: process.env.EASY100_INPUT_PATH,
      predictionsPath: process.env.RUNTIME_AWARE_PREDICTIONS_PATH,
      outputDir,
      caseIds: parseCaseIds(process.env.SCHEMA_REPAIR_CASE_IDS),
      options: {
        model: process.env.SCHEMA_REPAIR_MODEL || 'qwen3.8:27b',
        reasoningEffort: process.env.SCHEMA_REPAIR_REASONING_EFFORT || 'none',
        maxToolRounds: Number.parseInt(process.env.SCHEMA_REPAIR_MAX_TOOL_ROUNDS || '4', 10),
        timeoutMs: Number.parseInt(process.env.SCHEMA_REPAIR_TIMEOUT_MS || '120000', 10),
      },
    }).then((report) => process.stdout.write(JSON.stringify(report.aggregate) + '\n'))
      .catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseCaseIds, runAuthoritativeSchemaRepairSmoke };
