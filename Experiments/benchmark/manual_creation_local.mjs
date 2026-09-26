#!/usr/bin/env node
/**
 * Local widget — creation (from-scratch) benchmark prepare.
 *
 *   node manual_creation_local.mjs prepare [--limit 60] [--force]
 *     → create empty workflow on local n8n, write run sheet URLs
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { createWorkflow } from './lib/n8n-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;
const LOCAL_URL = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
const LOCAL_API_KEY = process.env.N8N_API_KEY || '';
const MANIFEST_PATH = resolve(BENCHMARK_ROOT, 'data/manifest_creation.json');
const RESULTS_ROOT = resolve(BENCHMARK_ROOT, 'results/local/create');
const SHEET_JSON = resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet_local.json');
const SHEET_MD = resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet_local.md');

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
    name: `local-create-${caseEntry.id}`,
    nodes: [],
    connections: {},
    settings: { executionOrder: 'v1' },
  };
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
    status: workflowUrl ? 'prepared' : 'pending',
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
    `# Local — Creation (${n} cases: low/med/high × 20)`,
    '',
    `**Local n8n:** ${sheet.baseUrl}`,
    '',
    'For each row: open **Workflow URL** (empty canvas), open the **chat widget**, paste **Instruction**, wait until done, **Save**.',
    '',
    'Full instructions: `data/creation/<case>/instruction.txt`',
    '',
    '| Done | Case | Complexity | Gold name | GT nodes | Workflow URL | Instruction |',
    '|------|------|------------|-----------|----------|--------------|-------------|',
  ];
  for (const row of sheet.cases) {
    const instr = String(row.instruction || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| [ ] | ${row.caseId} | ${row.complexity || ''} | ${String(row.goldName || '').replace(/\|/g, '\\|')} | ${row.gtNodes ?? '?'} | ${row.workflowUrl} | ${instr} |`
    );
  }
  lines.push('', 'After all runs:', '', '```bash', 'node manual_creation_cloud.mjs summary  # or score locally', '```');
  writeFileSync(SHEET_MD, lines.join('\n'), 'utf8');
}

async function cmdPrepare(cases, { force }) {
  if (!LOCAL_API_KEY) throw new Error('N8N_API_KEY required in Experiments/benchmark/.env');

  const sheet = existsSync(SHEET_JSON) ? readJson(SHEET_JSON) : { cases: [] };
  const batchRows = [];

  for (const caseEntry of cases) {
    const outDir = join(RESULTS_ROOT, caseEntry.id);
    const metaPath = join(outDir, 'meta.json');
    ensureDir(outDir);

    let meta = existsSync(metaPath) ? readJson(metaPath) : {};
    const instruction = instructionForCase(caseEntry);

    if (meta.workflowId && meta.mode === 'manual_local_create' && !force) {
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

    const created = await createWorkflow(LOCAL_URL, LOCAL_API_KEY, emptyWorkflowDoc(caseEntry));
    const workflowUrl = `${LOCAL_URL}/workflow/${created.id}`;

    meta = {
      caseId: caseEntry.id,
      operation: 'create',
      mode: 'manual_local_create',
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

  sheet.baseUrl = LOCAL_URL;
  sheet.mode = 'manual_local_create';
  mergeSheetCases(sheet, batchRows);
  writeJson(SHEET_JSON, sheet);
  writeMarkdownSheet(sheet);
  console.log(`\nWrote ${SHEET_JSON}`);
  console.log(`Wrote ${SHEET_MD}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (cmd !== 'prepare') {
    console.error('Usage: node manual_creation_local.mjs prepare [--limit 60] [--force]');
    process.exit(1);
  }

  const manifest = loadManifest();
  const cases = filterCases(manifest, {
    limit: args.limit,
    offset: args.offset,
    caseId: args['case-id'],
  });
  console.log(`Local creation prepare: ${cases.length} cases → ${LOCAL_URL}`);
  await cmdPrepare(cases, { force: !!args.force });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
