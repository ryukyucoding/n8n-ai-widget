#!/usr/bin/env node
/**
 * Manual Cloud AI Builder — creation (from-scratch) benchmark.
 *
 *   node manual_creation_cloud.mjs prepare [--limit 20]
 *     → create empty workflow on Cloud, write URLs + instructions
 *
 *   (paste instruction in AI Builder on each empty canvas, save)
 *
 *   node manual_creation_cloud.mjs fetch [--force]
 *     → GET workflow, score vs gold (Node/Connection/Matched-Conn F1, Param Acc)
 *
 *   node manual_creation_cloud.mjs summary
 *     → aggregate metrics across scored cases
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { createWorkflow, getWorkflow, workflowSignature } from './lib/n8n-api.mjs';
import { normalizePredWorkflow } from './lib/score-creation.mjs';
import { scoreCreation } from './lib/score-creation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;
const CLOUD_URL = (process.env.N8N_CLOUD_URL || 'https://widmn8n.app.n8n.cloud').replace(/\/$/, '');
const CLOUD_API_KEY = process.env.N8N_CLOUD_API_KEY || '';
const MANIFEST_PATH = resolve(BENCHMARK_ROOT, 'data/manifest_creation.json');
const RESULTS_ROOT = resolve(BENCHMARK_ROOT, 'results/cloud/create');
const SHEET_JSON = resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet.json');
const SHEET_MD = resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet.md');
const DEFAULT_VENV_PY = resolve(BENCHMARK_ROOT, '.venv/bin/python');
const PYTHON_BIN =
  process.env.PYTHON_BIN || (existsSync(DEFAULT_VENV_PY) ? DEFAULT_VENV_PY : 'python3');

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

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing ${MANIFEST_PATH} — run: python3 dataset/prepare_creation_dataset.py`);
  }
  return readJson(MANIFEST_PATH);
}

function filterCases(manifest, { limit, offset, caseId }) {
  let cases = manifest.cases || [];
  if (caseId) cases = cases.filter((c) => c.id === caseId);
  const off = Number(offset || 0);
  const lim = limit != null ? Number(limit) : cases.length;
  return cases.slice(off, off + lim);
}

function emptyWorkflowDoc(caseEntry) {
  return {
    name: `cloud-create-${caseEntry.id}`,
    nodes: [],
    connections: {},
    settings: { executionOrder: 'v1' },
  };
}

function scoreCreationCase(goldPath, predPath, outScorePath, skipParam) {
  return scoreCreation({
    goldPath,
    predPath,
    outScorePath,
    skipParam,
    normalize: false,
  });
}

function instructionForCase(caseEntry) {
  const instructionPath = resolve(BENCHMARK_ROOT, caseEntry.instruction_path);
  return existsSync(instructionPath)
    ? readFileSync(instructionPath, 'utf8').trim()
    : caseEntry.instruction;
}

function sheetRowFromCase(caseEntry, { workflowId, workflowUrl, instruction }) {
  return {
    caseId: caseEntry.id,
    workflowId,
    workflowUrl,
    goldName: caseEntry.gold_name,
    complexity: caseEntry.complexity || '',
    gtNodes: caseEntry.functional_node_count,
    instruction,
    status: 'prepared',
  };
}

function mergeSheetCases(sheet, rows) {
  const byId = Object.fromEntries((sheet.cases || []).map((r) => [r.caseId, r]));
  for (const row of rows) byId[row.caseId] = { ...byId[row.caseId], ...row };
  sheet.cases = Object.values(byId).sort((a, b) => a.caseId.localeCompare(b.caseId));
  sheet.preparedAt = new Date().toISOString();
  return sheet;
}

function writeMarkdownSheet(sheet) {
  const n = (sheet.cases || []).length;
  const lines = [
    `# Manual Cloud AI Builder — Creation (${n} cases: low/med/high × 20)`,
    '',
    `Cloud: ${sheet.cloudUrl}`,
    '',
    'For each row: open **Workflow URL** (empty canvas), open AI Builder, paste **Instruction**, wait until done, **Save**.',
    '',
    'Full instructions also live in `data/creation/<case>/instruction.txt`.',
    '',
    '| Done | Case | Complexity | Gold name | GT nodes | Workflow URL | Instruction |',
    '|------|------|------------|-----------|----------|--------------|-------------|',
  ];
  for (const row of sheet.cases) {
    const instr = String(row.instruction || row.instructionPreview || '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
    lines.push(
      `| [ ] | ${row.caseId} | ${row.complexity || ''} | ${(row.goldName || '').replace(/\|/g, '\\|')} | ${row.gtNodes ?? '?'} | ${row.workflowUrl} | ${instr} |`
    );
  }
  lines.push(
    '',
    'After all edits:',
    '',
    '```bash',
    'node manual_creation_cloud.mjs fetch --force',
    'node manual_creation_cloud.mjs summary',
    '```'
  );
  writeFileSync(SHEET_MD, lines.join('\n'), 'utf8');
}

function cmdRebuildSheet(allCases) {
  const sheet = existsSync(SHEET_JSON) ? readJson(SHEET_JSON) : { cases: [] };
  sheet.cloudUrl = CLOUD_URL;
  sheet.mode = 'manual_create';
  const rows = [];
  for (const caseEntry of allCases) {
    const metaPath = join(RESULTS_ROOT, caseEntry.id, 'meta.json');
    const instruction = instructionForCase(caseEntry);
    if (!existsSync(metaPath)) {
      console.warn(`[warn] ${caseEntry.id}: no meta.json — run prepare first`);
      continue;
    }
    const meta = readJson(metaPath);
    rows.push(
      sheetRowFromCase(caseEntry, {
        workflowId: meta.workflowId,
        workflowUrl: meta.workflowUrl,
        instruction,
      })
    );
    console.log(`[sheet] ${caseEntry.id} → ${meta.workflowUrl}`);
  }
  mergeSheetCases(sheet, rows);
  writeJson(SHEET_JSON, sheet);
  writeMarkdownSheet(sheet);
  console.log(`\nWrote ${SHEET_JSON}`);
  console.log(`Wrote ${SHEET_MD} (${sheet.cases.length} cases)`);
}

async function cmdPrepare(cases, { force }) {
  if (!CLOUD_API_KEY) throw new Error('N8N_CLOUD_API_KEY required');

  const sheet = existsSync(SHEET_JSON) ? readJson(SHEET_JSON) : { cases: [] };
  const batchRows = [];

  for (const caseEntry of cases) {
    const outDir = join(RESULTS_ROOT, caseEntry.id);
    const metaPath = join(outDir, 'meta.json');
    ensureDir(outDir);

    let meta = existsSync(metaPath) ? readJson(metaPath) : {};
    const instruction = instructionForCase(caseEntry);

    if (meta.workflowId && meta.mode === 'manual_create' && !force) {
      console.log(`[keep] ${caseEntry.id} → ${meta.workflowUrl}`);
      batchRows.push(
        sheetRowFromCase(caseEntry, {
          workflowId: meta.workflowId,
          workflowUrl: meta.workflowUrl,
          instruction,
        })
      );
      continue;
    }

    const created = await createWorkflow(CLOUD_URL, CLOUD_API_KEY, emptyWorkflowDoc(caseEntry));
    const workflowUrl = `${CLOUD_URL}/workflow/${created.id}`;

    meta = {
      caseId: caseEntry.id,
      operation: 'create',
      mode: 'manual_create',
      preparedAt: new Date().toISOString(),
      workflowId: created.id,
      workflowUrl,
      instructionSent: instruction,
      goldName: caseEntry.gold_name,
      complexity: caseEntry.complexity,
      sourceRowId: caseEntry.source_row_id,
      functionalNodeCount: caseEntry.functional_node_count,
      workflowKept: true,
    };
    writeJson(metaPath, meta);

    batchRows.push(
      sheetRowFromCase(caseEntry, {
        workflowId: created.id,
        workflowUrl,
        instruction,
      })
    );
    console.log(`[import] ${caseEntry.id} → ${workflowUrl}`);
  }

  sheet.cloudUrl = CLOUD_URL;
  sheet.mode = 'manual_create';
  mergeSheetCases(sheet, batchRows);
  writeJson(SHEET_JSON, sheet);
  writeMarkdownSheet(sheet);
  console.log(`\nWrote ${SHEET_JSON}`);
  console.log(`Wrote ${SHEET_MD}`);
}

async function cmdFetch(cases, { force, skipParam }) {
  if (!CLOUD_API_KEY) throw new Error('N8N_CLOUD_API_KEY required');

  const sheet = existsSync(SHEET_JSON) ? readJson(SHEET_JSON) : { cases: [] };
  const byId = Object.fromEntries((sheet.cases || []).map((r) => [r.caseId, r]));

  for (const caseEntry of cases) {
    const outDir = join(RESULTS_ROOT, caseEntry.id);
    const metaPath = join(outDir, 'meta.json');
    const predPath = join(outDir, 'pred.json');
    const scorePath = join(outDir, 'score.json');
    const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);

    if (!force && existsSync(predPath) && existsSync(scorePath)) {
      console.log(`[skip] ${caseEntry.id} already scored`);
      continue;
    }

    const meta = existsSync(metaPath) ? readJson(metaPath) : {};
    const workflowId = meta.workflowId || byId[caseEntry.id]?.workflowId;
    if (!workflowId) {
      console.error(`[error] ${caseEntry.id}: no workflowId — run prepare first`);
      continue;
    }

    const baseSig = workflowSignature(emptyWorkflowDoc(caseEntry));
    let pred;
    try {
      pred = await getWorkflow(CLOUD_URL, CLOUD_API_KEY, workflowId);
    } catch (e) {
      console.error(`[error] ${caseEntry.id}: GET failed: ${e.message}`);
      continue;
    }

    const changed = workflowSignature(pred) !== baseSig;
    const normalizedPred = normalizePredWorkflow(pred);
    writeJson(predPath, normalizedPred);

    writeJson(metaPath, {
      ...meta,
      fetchedAt: new Date().toISOString(),
      workflowChangedFromEmpty: changed,
    });

    const { ok, score, stderr } = scoreCreationCase(goldPath, predPath, scorePath, skipParam);
    const s = score?.summary || {};
    const tag = changed ? 'changed' : 'unchanged';
    console.log(
      `[${ok ? 'OK' : 'FAIL'}] ${caseEntry.id} ${tag}  ` +
        `node_f1=${s.node_f1 ?? '?'} conn_f1=${s.connection_f1 ?? '?'} ` +
        `matched_conn_f1=${s.matched_connection_f1 ?? '?'} param=${s.parameter_accuracy ?? '?'}`
    );
    if (stderr?.trim()) console.error(stderr.trim().slice(0, 400));

    if (byId[caseEntry.id]) {
      byId[caseEntry.id].fetchedAt = new Date().toISOString();
      byId[caseEntry.id].metrics = s;
      byId[caseEntry.id].changed = changed;
    }
  }

  sheet.cases = mergeSheetCases(sheet, cases.map((c) => byId[c.id]).filter(Boolean)).cases;
  sheet.fetchedAt = new Date().toISOString();
  writeJson(SHEET_JSON, sheet);
}

function cmdSummary() {
  const proc = spawnSync(PYTHON_BIN, [join(BENCHMARK_ROOT, 'analysis/creation_metrics_summary.py')], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(proc.status ?? 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  const manifest = loadManifest();
  const cases = filterCases(manifest, {
    limit: args.limit,
    offset: args.offset,
    caseId: args['case-id'],
  });

  if (cmd === 'prepare') {
    await cmdPrepare(cases, { force: !!args.force });
    return;
  }
  if (cmd === 'rebuild-sheet') {
    cmdRebuildSheet(manifest.cases || []);
    return;
  }
  if (cmd === 'fetch') {
    await cmdFetch(cases, { force: !!args.force, skipParam: !!args['skip-parameter-eval'] });
    return;
  }
  if (cmd === 'summary') {
    cmdSummary();
    return;
  }

  console.error(
    'Usage: node manual_creation_cloud.mjs prepare|fetch|summary|rebuild-sheet [--limit N] [--offset N] [--force] [--skip-parameter-eval]'
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
