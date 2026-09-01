'use strict';

// Audit the legacy source answers against the current runtime schema. This
// separates dataset-version drift from model-generation failures without a
// model call, n8n API call, or workflow execution.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { findingCategoryCounts, readinessFrom, safeCapabilitySummary, verifyStatic } = require('./runEasy100Batch');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function readSourceAnswers(inputPath, limit) {
  const rows = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return rows.slice(0, limit).map((row, index) => {
    const assistant = Array.isArray(row.messages) ? row.messages.find((message) => message?.role === 'assistant') : null;
    const user = Array.isArray(row.messages) ? row.messages.find((message) => message?.role === 'user') : null;
    let workflow = null;
    try { workflow = typeof assistant?.content === 'string' ? JSON.parse(assistant.content) : null; } catch {}
    return { caseId: String(row?.id ?? index), userRequest: typeof user?.content === 'string' ? user.content : '', workflow };
  });
}

async function main() {
  const inputPath = process.env.EASY100_INPUT_PATH;
  const outputPath = process.env.EASY100_GROUND_TRUTH_AUDIT_OUTPUT_PATH;
  const limit = Number.parseInt(process.env.EASY100_LIMIT || '100', 10);
  if (!inputPath || !outputPath) throw new Error('EASY100_INPUT_PATH and EASY100_GROUND_TRUTH_AUDIT_OUTPUT_PATH are required');

  const cases = readSourceAnswers(inputPath, Number.isInteger(limit) && limit > 0 ? limit : 100);
  const records = [];
  for (const testCase of cases) {
    if (!testCase.workflow || !testCase.userRequest) {
      records.push({ caseId: testCase.caseId, status: 'not_parseable', findingCategories: {}, executionReadiness: 'not_parseable' });
      continue;
    }
    const verification = await verifyStatic(testCase.workflow, testCase.userRequest);
    const capability = safeCapabilitySummary(testCase.workflow);
    records.push({
      caseId: testCase.caseId,
      status: verification.status,
      findingCategories: findingCategoryCounts(verification),
      capability,
      executionReadiness: readinessFrom({ parsed: { ok: true }, verification, capability }).category,
    });
  }
  const findingCategories = {};
  const readiness = {};
  for (const record of records) {
    readiness[record.executionReadiness] = (readiness[record.executionReadiness] || 0) + 1;
    for (const [category, count] of Object.entries(record.findingCategories)) findingCategories[category] = (findingCategories[category] || 0) + count;
  }
  const report = {
    schemaVersion: '1.0',
    kind: 'easy100_source_ground_truth_runtime_audit',
    executionPolicy: 'no_model_no_n8n_execution',
    inputFingerprint: sha256(fs.readFileSync(inputPath, 'utf8')),
    audited: records.length,
    staticPass: records.filter((record) => record.status === 'pass' || record.status === 'warning').length,
    executionReadiness: readiness,
    findingCategories,
    records,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(JSON.stringify({ audited: report.audited, staticPass: report.staticPass, executionReadiness: report.executionReadiness, findingCategories: report.findingCategories }) + '\n');
}

main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
