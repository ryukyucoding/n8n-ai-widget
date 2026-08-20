'use strict';

// A bounded Plan -> Create diagnosis across a few fixed inputs. It reports
// stage outcomes only and never creates or executes n8n workflows.

const fs = require('node:fs');
const path = require('node:path');
const { runPlanFirstCreatePreflight } = require('./runPlanFirstCreatePreflight');

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function parseIndices(value) {
  const indices = String(value || '0,1,2').split(',').map((part) => Number.parseInt(part.trim(), 10));
  if (!indices.length || indices.length > 5 || indices.some((index) => !Number.isInteger(index) || index < 0)) throw new TypeError('case indices must contain one to five non-negative integers');
  return [...new Set(indices)];
}

function increment(target, key) { target[key] = (target[key] || 0) + 1; }

async function runPlanFirstCreateSmoke({ inputPath, outputDir, caseIndices = [0, 1, 2], options = {}, runPreflight = runPlanFirstCreatePreflight } = {}) {
  if (!inputPath || !outputDir) throw new TypeError('inputPath and outputDir are required');
  const records = [];
  for (const caseIndex of caseIndices) {
    const report = await runPreflight({ inputPath, outputPath: path.join(outputDir, 'private', 'preflights', `${caseIndex}.json`), caseIndex, ...options });
    records.push({
      caseId: String(report.caseId ?? caseIndex), outcome: report.outcome,
      failureCategory: report.failureCategory || null,
      staticStatus: report.create?.staticStatus || null,
      missingSelectedNodeTypeCount: Number.isInteger(report.create?.planCompliance?.missingSelectedNodeTypeCount) ? report.create.planCompliance.missingSelectedNodeTypeCount : null,
      nodesOutsideSelectedPlanCount: Number.isInteger(report.create?.planCompliance?.nodesOutsideSelectedPlanCount) ? report.create.planCompliance.nodesOutsideSelectedPlanCount : null,
      findingCategories: report.create?.findingCategories || {},
    });
  }
  const outcomes = {};
  const staticStatuses = {};
  const findings = {};
  for (const record of records) {
    increment(outcomes, record.outcome || 'unknown');
    if (record.staticStatus) increment(staticStatuses, record.staticStatus);
    for (const [category, count] of Object.entries(record.findingCategories)) findings[category] = (findings[category] || 0) + count;
  }
  const report = {
    schemaVersion: '1.0', kind: 'plan_first_create_smoke', executionPolicy: 'no_n8n_create_or_execution',
    model: { planner: options.plannerModel || 'qwen3.8:27b', plannerMode: options.plannerMode || 'json', create: options.createModel || 'qwen2.5-coder-32b-ft-original:latest' },
    records,
    aggregate: { attemptedCases: records.length, outcomes, staticStatuses, findingCategories: findings, builderOmittedPlannedNodeCases: records.filter((record) => (record.missingSelectedNodeTypeCount || 0) > 0).length, builderPlanViolationCases: records.filter((record) => (record.nodesOutsideSelectedPlanCount || 0) > 0).length },
  };
  atomicWrite(path.join(outputDir, 'plan-first-create-smoke.json'), report);
  return report;
}

if (require.main === module) {
  try {
    runPlanFirstCreateSmoke({
      inputPath: process.env.PLAN_FIRST_INPUT_PATH,
      outputDir: process.env.PLAN_FIRST_OUTPUT_DIR,
      caseIndices: parseIndices(process.env.PLAN_FIRST_CASE_INDICES),
      options: {
        plannerModel: process.env.PLAN_FIRST_PLANNER_MODEL || 'qwen3.8:27b', plannerMode: process.env.PLAN_FIRST_PLANNER_MODE || 'json', createModel: process.env.PLAN_FIRST_CREATE_MODEL || 'qwen2.5-coder-32b-ft-original:latest',
        plannerMaxTokens: Number.parseInt(process.env.PLAN_FIRST_PLANNER_MAX_TOKENS || '700', 10), plannerReasoningEffort: process.env.PLAN_FIRST_PLANNER_REASONING_EFFORT || 'none',
        plannerTimeoutMs: Number.parseInt(process.env.PLAN_FIRST_PLANNER_TIMEOUT_MS || '60000', 10), createTimeoutMs: Number.parseInt(process.env.PLAN_FIRST_CREATE_TIMEOUT_MS || '180000', 10),
      },
    }).then((report) => process.stdout.write(`${JSON.stringify(report.aggregate)}\n`)).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
  } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; }
}

module.exports = { parseIndices, runPlanFirstCreateSmoke };
