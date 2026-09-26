#!/usr/bin/env node
/**
 * Sync run sheets with manifest (preserve existing workflow URLs).
 *
 *   node scripts/bootstrap_run_sheets.mjs
 *   node scripts/bootstrap_run_sheets.mjs --clean   # empty workflow URLs (for sharing)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pathsForTarget,
  loadManifest,
  bootstrapSheetFromManifest,
  writeMarkdownSheet,
  writeJson,
  readJson,
} from '../lib/creation_edit_run_sheet.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');
const CREATION_MANIFEST = resolve(BENCHMARK_ROOT, 'data/manifest_creation.json');
const CREATION_SHEET_JSON = resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet.json');
const CREATION_SHEET_MD = resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet.md');

function bootstrapCreationSheet() {
  if (!existsSync(CREATION_MANIFEST)) {
    console.warn(`Skip creation sheet — missing ${CREATION_MANIFEST}`);
    return;
  }
  const manifest = readJson(CREATION_MANIFEST);
  const existing = existsSync(CREATION_SHEET_JSON) ? readJson(CREATION_SHEET_JSON) : { cases: [] };
  const byId = Object.fromEntries((existing.cases || []).map((r) => [r.caseId, r]));

  for (const caseEntry of manifest.cases || []) {
    const instructionPath = resolve(BENCHMARK_ROOT, caseEntry.instruction_path);
    const instruction = existsSync(instructionPath)
      ? readFileSync(instructionPath, 'utf8').trim()
      : caseEntry.instruction;
    const prev = byId[caseEntry.id] || {};
    byId[caseEntry.id] = {
      caseId: caseEntry.id,
      workflowId: prev.workflowId || '',
      workflowUrl: prev.workflowUrl || '',
      goldName: caseEntry.gold_name || '',
      complexity: caseEntry.complexity || '',
      gtNodes: caseEntry.functional_node_count,
      instruction,
      status: prev.workflowUrl ? 'prepared' : 'pending',
    };
  }

  const n = (manifest.cases || []).length;
  const sheet = {
    ...existing,
    cloudUrl: existing.cloudUrl || 'https://widmn8n.app.n8n.cloud',
    cases: Object.values(byId).sort((a, b) => a.caseId.localeCompare(b.caseId)),
    preparedAt: new Date().toISOString(),
  };
  writeJson(CREATION_SHEET_JSON, sheet);

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
    const instr = String(row.instruction || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| [ ] | ${row.caseId} | ${row.complexity || ''} | ${String(row.goldName || '').replace(/\|/g, '\\|')} | ${row.gtNodes ?? '?'} | ${row.workflowUrl} | ${instr} |`
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
  writeFileSync(CREATION_SHEET_MD, lines.join('\n'), 'utf8');
  console.log(`Wrote ${CREATION_SHEET_JSON} (${n} cases)`);
  console.log(`Wrote ${CREATION_SHEET_MD}`);
}

function parseCleanFlag() {
  return process.argv.includes('--clean');
}

function main() {
  const clean = parseCleanFlag();
  const manifest = loadManifest(BENCHMARK_ROOT);

  for (const target of clean ? ['cloud'] : ['local', 'cloud']) {
    const paths = pathsForTarget(target);
    for (const op of ['delete', 'insert']) {
      const jsonPath = paths[op].json;
      let existing = clean ? { cases: [] } : existsSync(jsonPath) ? readJson(jsonPath) : { cases: [] };
      if (!existing.baseUrl && target === 'cloud') {
        existing.baseUrl = 'https://widmn8n.app.n8n.cloud';
      }
      if (clean && target === 'local') {
        existing.baseUrl = 'http://localhost:5678';
      }
      const sheet = bootstrapSheetFromManifest(manifest, op, target, existing);
      writeJson(jsonPath, sheet);
      writeMarkdownSheet(sheet, op, target, paths);
      console.log(`Wrote ${jsonPath} (${sheet.cases.length} cases${clean ? ', clean' : ''})`);
      console.log(`Wrote ${paths[op].md}`);
    }
  }

  if (clean) {
    bootstrapCreationSheetClean();
  } else {
    bootstrapCreationSheet();
  }
}

function bootstrapCreationSheetClean() {
  if (!existsSync(CREATION_MANIFEST)) {
    console.warn(`Skip creation sheet — missing ${CREATION_MANIFEST}`);
    return;
  }
  const manifest = readJson(CREATION_MANIFEST);
  const byId = {};

  for (const caseEntry of manifest.cases || []) {
    const instructionPath = resolve(BENCHMARK_ROOT, caseEntry.instruction_path);
    const instruction = existsSync(instructionPath)
      ? readFileSync(instructionPath, 'utf8').trim()
      : caseEntry.instruction;
    byId[caseEntry.id] = {
      caseId: caseEntry.id,
      workflowId: '',
      workflowUrl: '',
      goldName: caseEntry.gold_name || '',
      complexity: caseEntry.complexity || '',
      gtNodes: caseEntry.functional_node_count,
      instruction,
      status: 'pending',
    };
  }

  const n = (manifest.cases || []).length;
  const sheet = {
    cloudUrl: 'https://widmn8n.app.n8n.cloud',
    cases: Object.values(byId).sort((a, b) => a.caseId.localeCompare(b.caseId)),
    preparedAt: new Date().toISOString(),
  };
  writeJson(CREATION_SHEET_JSON, sheet);

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
    const instr = String(row.instruction || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| [ ] | ${row.caseId} | ${row.complexity || ''} | ${String(row.goldName || '').replace(/\|/g, '\\|')} | ${row.gtNodes ?? '?'} | ${row.workflowUrl} | ${instr} |`
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
  writeFileSync(CREATION_SHEET_MD, lines.join('\n'), 'utf8');
  console.log(`Wrote ${CREATION_SHEET_JSON} (${n} cases, clean)`);
  console.log(`Wrote ${CREATION_SHEET_MD}`);
}

main();
