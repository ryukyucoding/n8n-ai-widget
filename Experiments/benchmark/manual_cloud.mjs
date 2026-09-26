#!/usr/bin/env node
/**
 * Manual Cloud AI Builder workflow (no Playwright prompt send).
 *
 *   node manual_cloud.mjs prepare --operation insert-partial --pilot
 *     → import base.json to Cloud, write workflow URLs + copy-paste instructions
 *
 *   (you edit each workflow in Cloud AI Builder by hand)
 *
 *   node manual_cloud.mjs fetch --operation insert-partial --pilot
 *     → GET workflow via API, score vs gold, print component rates
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadManifest, filterCases } from './lib/args.mjs';
import { promptInstruction, formatResultTag, formatInsertDetailLines } from './lib/result-tag.mjs';
import {
  stripWorkflowForImport,
  createWorkflow,
  getWorkflow,
  workflowSignature,
} from './lib/n8n-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;
const CLOUD_URL = (process.env.N8N_CLOUD_URL || 'https://widmn8n.app.n8n.cloud').replace(/\/$/, '');
const CLOUD_API_KEY = process.env.N8N_CLOUD_API_KEY || '';
const MANIFEST_PATH = resolve(BENCHMARK_ROOT, process.env.BENCHMARK_MANIFEST || 'data/manifest.json');
const RESULTS_ROOT = resolve(BENCHMARK_ROOT, 'results/cloud');
const SHEET_PATH = resolve(BENCHMARK_ROOT, 'run_sheets/manual_run_sheet.json');
const SHEET_MD_PATH = resolve(BENCHMARK_ROOT, 'run_sheets/manual_run_sheet.md');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3.12';

const PILOT_SUFFIXES = new Set([
  '001', '002', '003', '004', '005', '006', '007', '008', '009',
  '015', '016', '018', '019', '041', '046', '047', '048', '054',
  '065', '069', '071', '082',
]);

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

function resultDir(caseEntry) {
  const op = caseEntry.scoring_operation || caseEntry.operation;
  return join(RESULTS_ROOT, op, caseEntry.id);
}

function scoringOperation(caseEntry) {
  return caseEntry.scoring_operation || caseEntry.operation;
}

function scoreCase(operation, basePath, goldPath, predPath, caseEntry, outScorePath) {
  const caseJsonPath = join(dirname(outScorePath), 'case.json');
  writeJson(caseJsonPath, caseEntry);
  const proc = spawnSync(
    PYTHON_BIN,
    [
      join(BENCHMARK_ROOT, 'score_case.py'),
      '--operation',
      operation,
      '--base',
      basePath,
      '--gold',
      goldPath,
      '--pred',
      predPath,
      '--case-json',
      caseJsonPath,
      '--out',
      outScorePath,
    ],
    { env: { ...process.env }, encoding: 'utf8' }
  );
  let score = null;
  if (existsSync(outScorePath)) {
    try {
      score = readJson(outScorePath);
    } catch {
      score = null;
    }
  }
  return { ok: proc.status === 0, score, stderr: proc.stderr };
}

function filterPilot(cases, pilotOnly) {
  if (!pilotOnly) return cases;
  return cases.filter((c) => {
    const parts = c.id.split('-');
    const suffix = parts[parts.length - 1];
    return PILOT_SUFFIXES.has(suffix);
  });
}

function componentRates(score) {
  const c = (score?.insert_detail || {}).checks || {};
  const m = score?.metrics || {};
  const p = c.parameters || {};
  let rate = p.coverage_rate;
  if (rate == null && m.gold_params_subset_ok) rate = 1;
  const col = c.collateral || {};
  const collateralClean =
    !(col.other_nodes_semantically_changed || []).length &&
    !(col.extra_nodes_beyond_insert || []).length &&
    !(col.base_nodes_missing_from_pred || []).length;
  return {
    splice: !!(c.splice_position?.ok || m.insert_main_neighbors_ok),
    type: !!(c.node_type_match?.ok || m.inserted_node_type_ok),
    paramsGt50: rate != null && Number(rate) > 0.5,
    noCollateral: collateralClean,
    coveragePct: rate != null ? Math.round(Number(rate) * 100) : null,
  };
}

function loadOrCreateSheet() {
  if (existsSync(SHEET_PATH)) {
    const sheet = readJson(SHEET_PATH);
    sheet.cases = sheet.cases || [];
    return sheet;
  }
  return {
    cloudUrl: CLOUD_URL,
    preparedAt: new Date().toISOString(),
    mode: 'manual_ai_builder',
    cases: [],
  };
}

function mergeSheetCases(sheet, rows) {
  const byId = Object.fromEntries((sheet.cases || []).map((r) => [r.caseId, r]));
  for (const row of rows) byId[row.caseId] = { ...byId[row.caseId], ...row };
  sheet.cases = Object.values(byId).sort((a, b) => a.caseId.localeCompare(b.caseId));
  sheet.preparedAt = new Date().toISOString();
  return sheet;
}

async function cmdPrepare(cases, { force }) {
  if (!CLOUD_API_KEY) throw new Error('N8N_CLOUD_API_KEY required in .env');

  const sheet = loadOrCreateSheet();
  sheet.cloudUrl = CLOUD_URL;
  sheet.mode = 'manual_ai_builder';
  const batchRows = [];

  for (const caseEntry of cases) {
    const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
    const outDir = resultDir(caseEntry);
    const metaPath = join(outDir, 'meta.json');
    ensureDir(outDir);

    let meta = existsSync(metaPath) ? readJson(metaPath) : {};
    if (meta.workflowId && meta.mode === 'manual' && !force) {
      console.log(`[keep] ${caseEntry.id} → ${meta.workflowUrl}`);
      batchRows.push({
        caseId: caseEntry.id,
        workflowId: meta.workflowId,
        workflowUrl: meta.workflowUrl,
        instruction: meta.instructionSent || promptInstruction(caseEntry),
        status: 'prepared',
      });
      continue;
    }

    const base = readJson(basePath);
    const doc = stripWorkflowForImport(base, `cloud-manual-${caseEntry.id}`);
    const created = await createWorkflow(CLOUD_URL, CLOUD_API_KEY, doc);
    const workflowUrl = `${CLOUD_URL}/workflow/${created.id}`;
    const instruction = promptInstruction(caseEntry);

    meta = {
      caseId: caseEntry.id,
      operation: caseEntry.operation,
      mode: 'manual',
      preparedAt: new Date().toISOString(),
      workflowId: created.id,
      workflowUrl,
      instructionSent: instruction,
      workflowKept: true,
      steps: [{ step: 'workflow_imported_manual', at: new Date().toISOString(), detail: { workflowId: created.id } }],
      _outDir: outDir,
    };
    writeJson(metaPath, meta);

    batchRows.push({
      caseId: caseEntry.id,
      workflowId: created.id,
      workflowUrl,
      instruction,
      status: 'prepared',
    });
    console.log(`[import] ${caseEntry.id} → ${workflowUrl}`);
  }

  mergeSheetCases(sheet, batchRows);
  writeJson(SHEET_PATH, sheet);
  writeMarkdownSheet(sheet);
  console.log(`\nWrote ${SHEET_PATH}`);
  console.log(`Wrote ${SHEET_MD_PATH}`);
  console.log(`\nNext: open each workflow URL, paste instruction into AI Builder, save. Then:`);
  console.log(`  node manual_cloud.mjs fetch --operation insert-partial --pilot`);
}

function writeMarkdownSheet(sheet) {
  const lines = [
    '# Manual Cloud AI Builder — insert-partial pilot',
    '',
    `Cloud: ${sheet.cloudUrl}`,
    '',
    'For each row: open **Workflow URL**, open AI Builder, paste **Instruction** (text only), wait until done, save workflow.',
    '',
    '| Done | Case | Workflow URL | Instruction |',
    '|------|------|--------------|-------------|',
  ];
  for (const row of sheet.cases) {
    const instr = String(row.instruction || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| [ ] | ${row.caseId} | ${row.workflowUrl} | ${instr} |`);
  }
  lines.push('', 'After all edits: `node manual_cloud.mjs fetch --operation insert-partial --pilot`');
  writeFileSync(SHEET_MD_PATH, lines.join('\n'), 'utf8');
}

async function cmdFetch(cases, { force }) {
  if (!CLOUD_API_KEY) throw new Error('N8N_CLOUD_API_KEY required');

  let sheet = existsSync(SHEET_PATH) ? readJson(SHEET_PATH) : { cases: [] };
  const sheetById = Object.fromEntries((sheet.cases || []).map((r) => [r.caseId, r]));

  const rates = { splice: 0, type: 0, coverageSum: 0, collateral: 0, n: 0 };

  for (const caseEntry of cases) {
    const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
    const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);
    const outDir = resultDir(caseEntry);
    const metaPath = join(outDir, 'meta.json');
    const predPath = join(outDir, 'pred.json');
    const scorePath = join(outDir, 'score.json');

    if (!force && existsSync(predPath) && existsSync(scorePath)) {
      const score = readJson(scorePath);
      const r = componentRates(score);
      if (r.splice) rates.splice += 1;
      if (r.type) rates.type += 1;
      if (r.coveragePct != null) rates.coverageSum += r.coveragePct / 100;
      if (r.noCollateral) rates.collateral += 1;
      rates.n += 1;
      console.log(`[skip] ${caseEntry.id} already scored`);
      continue;
    }

    let meta = existsSync(metaPath) ? readJson(metaPath) : {};
    const workflowId = meta.workflowId || sheetById[caseEntry.id]?.workflowId;
    if (!workflowId) {
      console.error(`[error] ${caseEntry.id}: no workflowId — run prepare first`);
      continue;
    }

    const base = readJson(basePath);
    const baseSig = workflowSignature(base);
    let pred;
    try {
      pred = await getWorkflow(CLOUD_URL, CLOUD_API_KEY, workflowId);
    } catch (e) {
      console.error(`[error] ${caseEntry.id}: GET workflow failed: ${e.message}`);
      continue;
    }

    const changed = workflowSignature(pred) !== baseSig;
    writeJson(predPath, pred);

    meta = {
      ...meta,
      caseId: caseEntry.id,
      operation: caseEntry.operation,
      mode: 'manual',
      fetchedAt: new Date().toISOString(),
      workflowId,
      workflowUrl: meta.workflowUrl || `${CLOUD_URL}/workflow/${workflowId}`,
      instructionSent: meta.instructionSent || promptInstruction(caseEntry),
      workflowChangedFromBase: changed,
      workflowKept: true,
    };
    writeJson(metaPath, meta);

    const { ok, score } = scoreCase(
      scoringOperation(caseEntry),
      basePath,
      goldPath,
      predPath,
      caseEntry,
      scorePath
    );

    const r = componentRates(score);
    rates.n += 1;
    if (r.splice) rates.splice += 1;
    if (r.type) rates.type += 1;
    if (r.coveragePct != null) rates.coverageSum += r.coveragePct / 100;
    if (r.noCollateral) rates.collateral += 1;

    const tag = formatResultTag({ operation: caseEntry.operation, score, meta });
    console.log(`[${tag}] ${caseEntry.id}  changed=${changed}  cov=${r.coveragePct ?? '?'}%`);
    if (score?.insert_detail?.summary_zh) console.log(`  ${score.insert_detail.summary_zh}`);
    for (const line of formatInsertDetailLines(score || {})) console.log(line);

    if (sheetById[caseEntry.id]) {
      sheetById[caseEntry.id].fetchedAt = meta.fetchedAt;
      sheetById[caseEntry.id].insertStatus = score?.insert_status_label;
      sheetById[caseEntry.id].componentRates = r;
    }
  }

  sheet = loadOrCreateSheet();
  mergeSheetCases(
    sheet,
    cases.map((c) => sheetById[c.id]).filter(Boolean)
  );
  sheet.fetchedAt = new Date().toISOString();
  writeJson(SHEET_PATH, sheet);

  if (rates.n > 0) {
    const pct = (x) => Math.round((100 * x) / rates.n * 10) / 10;
    console.log('\n=== Cloud insert-partial component rates (% of scored) ===');
    console.log(`n = ${rates.n}`);
    console.log(`Position OK:     ${pct(rates.splice)}%`);
    console.log(`Type OK:         ${pct(rates.type)}%`);
    const meanCov = Math.round((100 * rates.coverageSum) / rates.n * 10) / 10;
    console.log(`Mean param coverage: ${meanCov}%`);
    console.log(`No collateral:   ${pct(rates.collateral)}%`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const args = parseArgs(rest);

  if (!existsSync(MANIFEST_PATH)) {
    console.error(`Missing manifest: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = loadManifest(MANIFEST_PATH);
  let cases = filterCases(manifest, {
    operation: args.operation || 'insert-partial',
    caseId: args['case-id'],
    limit: args.limit,
    offset: args.offset,
  });
  cases = filterPilot(cases, !!args.pilot);

  if (cmd === 'prepare') {
    await cmdPrepare(cases, { force: !!args.force });
    return;
  }
  if (cmd === 'fetch') {
    await cmdFetch(cases, { force: !!args.force });
    return;
  }

  console.error('Usage: node manual_cloud.mjs prepare|fetch --operation insert-partial [--pilot] [--force]');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
