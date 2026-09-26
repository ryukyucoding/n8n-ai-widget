#!/usr/bin/env node
/**
 * Add original gold-template URLs and repo paths to all run sheets.
 *
 *   node scripts/enrich_run_sheets.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pathsForTarget,
  loadManifest,
  writeMarkdownSheet,
  writeJson,
  readJson,
  sheetTitle,
} from '../lib/creation_edit_run_sheet.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');
const REFS_PATH = resolve(BENCHMARK_ROOT, 'data/gold_template_refs.json');
const CREATION_MANIFEST = resolve(BENCHMARK_ROOT, 'data/manifest_creation.json');

function loadGoldRefs() {
  if (!existsSync(REFS_PATH)) return { local: {}, cloud: {} };
  return readJson(REFS_PATH);
}

function refFor(refs, target, createId) {
  const r = refs[target]?.[createId];
  if (!r) return { url: '', path: '', name: '' };
  return {
    url: r.workflowUrl || '',
    path: r.goldPath || `data/creation/${createId}/gold.json`,
    name: r.goldName || '',
  };
}

function enrichCreationSheet(sheetPath, mdPath, target, refs) {
  if (!existsSync(sheetPath)) return;
  const sheet = readJson(sheetPath);
  const baseTarget = target === 'cloud' ? 'cloud' : 'local';
  sheet.cases = (sheet.cases || []).map((row) => {
    const gold = refFor(refs, baseTarget, row.caseId);
    return {
      ...row,
      originalTemplateId: row.caseId,
      originalTemplateUrl: gold.url,
      originalTemplatePath: gold.path,
    };
  });
  writeJson(sheetPath, sheet);

  const n = sheet.cases.length;
  const lines = [
    `# ${target === 'local' ? 'Local' : 'Cloud'} — Creation (${n} cases: low/med/high × 20)`,
    '',
    `**${target === 'local' ? 'Local n8n' : 'Cloud'}:** ${sheet.baseUrl || sheet.cloudUrl || ''}`,
    '',
    target === 'local'
      ? 'For each row: open **Canvas URL** (empty), use **chat widget**, paste **Instruction**, **Save**.'
      : 'For each row: open **Canvas URL** (empty), use **AI Builder**, paste **Instruction**, **Save**.',
    '',
    '**Original template URL** = gold reference workflow (full oracle from S1 dataset).',
    '',
    '| Done | Case | Complexity | Gold name | GT nodes | Canvas URL | Original template URL | Gold file | Instruction |',
    '|------|------|------------|-----------|----------|------------|----------------------|-----------|-------------|',
  ];
  for (const row of sheet.cases) {
    const instr = String(row.instruction || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| [ ] | ${row.caseId} | ${row.complexity || ''} | ${String(row.goldName || '').replace(/\|/g, '\\|')} | ${row.gtNodes ?? '?'} | ${row.workflowUrl || ''} | ${row.originalTemplateUrl || ''} | \`${row.originalTemplatePath || ''}\` | ${instr} |`
    );
  }
  lines.push('', 'After all runs:', '', '```bash', 'node manual_creation_cloud.mjs fetch --force', '```');
  writeFileSync(mdPath, lines.join('\n'), 'utf8');
  console.log(`Wrote ${sheetPath} + ${mdPath}`);
}

function enrichEditSheet(op, target, refs) {
  const paths = pathsForTarget(target);
  const jsonPath = paths[op].json;
  if (!existsSync(jsonPath)) return;

  const manifest = loadManifest(BENCHMARK_ROOT);
  const cases = op === 'delete' ? manifest.delete_cases : manifest.insert_cases;
  const caseById = Object.fromEntries(cases.map((c) => [c.id, c]));
  const sheet = readJson(jsonPath);
  const baseTarget = target;

  sheet.cases = (sheet.cases || []).map((row) => {
    const entry = caseById[row.caseId] || {};
    const sourceId = row.sourceCreateId || entry.source_create_id || '';
    const gold = refFor(refs, baseTarget, sourceId);
    const canvasPath = entry.base_path || '';
    const expectedPath = entry.gold_path || '';
    return {
      ...row,
      sourceCreateId: sourceId,
      originalTemplateId: sourceId,
      originalTemplateUrl: gold.url,
      originalTemplatePath: gold.path,
      canvasBasePath: canvasPath,
      expectedGoldPath: expectedPath,
    };
  });
  writeJson(jsonPath, sheet);

  const cfg = op === 'delete' ? 'delete' : 'insert';
  const isLocal = target === 'local';
  const title = sheetTitle(op, sheet.cases.length);
  const instrDir =
    op === 'delete' ? 'data/creation_edit/delete' : 'data/creation_edit/insert';

  const lines = [
    `# ${isLocal ? 'Local' : 'Cloud'} — ${title}`,
    '',
    `**${isLocal ? 'Local n8n' : 'Cloud'}:** ${sheet.baseUrl || ''}`,
    '',
    isLocal
      ? 'Open **Canvas URL**, use **chat widget**, paste **Instruction**, **Save**.'
      : 'Open **Canvas URL**, use **AI Builder**, paste **Instruction**, **Save**.',
    '',
    '**Original template URL** = full gold workflow (`create-NNN`) before any edit.',
    op === 'delete'
      ? 'Delete canvas = full template; expected result in `expectedGoldPath`.'
      : 'Insert canvas = post-delete base; original template = full gold to restore.',
    '',
    `Instructions: \`${instrDir}/<case>/instruction.txt\``,
    '',
    '| Done | Case | Source create | Complexity | Target node | Canvas URL | Original template URL | Canvas base file | Expected gold file | Instruction |',
    '|------|------|---------------|------------|-------------|------------|----------------------|------------------|---------------------|-------------|',
  ];

  for (const row of sheet.cases) {
    const instr = String(row.instruction || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| [ ] | ${row.caseId} | ${row.sourceCreateId || ''} | ${row.complexity || ''} | ${String(row.targetNode || '').replace(/\|/g, '\\|')} | ${row.workflowUrl || ''} | ${row.originalTemplateUrl || ''} | \`${row.canvasBasePath || ''}\` | \`${row.expectedGoldPath || ''}\` | ${instr} |`
    );
  }

  lines.push('', 'After all runs:', '', '```bash');
  if (isLocal) {
    lines.push(`node run_local.mjs --operation ${cfg} --force`);
  } else {
    lines.push(`node manual_creation_edit_cloud.mjs fetch ${op} --force`);
  }
  lines.push('```');

  writeFileSync(paths[op].md, lines.join('\n'), 'utf8');
  console.log(`Wrote ${jsonPath} + ${paths[op].md}`);
}

function main() {
  const refs = loadGoldRefs();

  enrichCreationSheet(
    resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet_local.json'),
    resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet_local.md'),
    'local',
    refs
  );
  enrichCreationSheet(
    resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet.json'),
    resolve(BENCHMARK_ROOT, 'run_sheets/creation_run_sheet.md'),
    'cloud',
    refs
  );

  for (const target of ['local', 'cloud']) {
    for (const op of ['delete', 'insert']) {
      enrichEditSheet(op, target, refs);
    }
  }
}

main();
