/**
 * Shared helpers for creation-edit manual run sheets (local + cloud).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MANIFEST_PATH = resolve(
  dirname(dirname(new URL(import.meta.url).pathname)),
  'data/manifest_creation_edit.json'
);

export const SHEET_CONFIG = {
  delete: {
    resultOp: 'create-del',
    instructionDir: 'data/creation_edit/delete',
    targetField: 'deletedNode',
    scoringOp: 'delete',
  },
  insert: {
    resultOp: 'create-ins',
    instructionDir: 'data/creation_edit/insert',
    targetField: 'targetNode',
    scoringOp: 'insert',
  },
};

export function pathsForTarget(target) {
  const isLocal = target === 'local';
  const suffix = isLocal ? '_local' : '_cloud';
  const root = dirname(dirname(new URL(import.meta.url).pathname));
  const runSheets = resolve(root, 'run_sheets');
  return {
    delete: {
      json: resolve(runSheets, `creation_delete_run_sheet${suffix}.json`),
      md: resolve(runSheets, `creation_delete_run_sheet${suffix}.md`),
    },
    insert: {
      json: resolve(runSheets, `creation_insert_run_sheet${suffix}.json`),
      md: resolve(runSheets, `creation_insert_run_sheet${suffix}.md`),
    },
  };
}

export function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

export function loadManifest(benchmarkRoot) {
  const p = resolve(benchmarkRoot, 'data/manifest_creation_edit.json');
  if (!existsSync(p)) {
    throw new Error(`Missing ${p} — run: python3 prepare_creation_edit_dataset.py`);
  }
  return readJson(p);
}

export function instructionForCase(benchmarkRoot, caseEntry) {
  const p = resolve(benchmarkRoot, caseEntry.instruction_path);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : caseEntry.instruction;
}

export function sheetRow(caseEntry, { workflowId, workflowUrl, instruction }) {
  const targetName =
    caseEntry.deleted_node_name || caseEntry.inserted_node_name || '';
  return {
    caseId: caseEntry.id,
    sourceCreateId: caseEntry.source_create_id,
    workflowId: workflowId || '',
    workflowUrl: workflowUrl || '',
    complexity: caseEntry.complexity || '',
    goldName: caseEntry.gold_name || '',
    gtNodes: caseEntry.functional_node_count,
    targetNode: targetName,
    instruction,
    status: workflowUrl ? 'prepared' : 'pending',
  };
}

export function sheetTitle(op, caseCount) {
  const n = caseCount ?? 60;
  return op === 'delete'
    ? `Creation-edit Delete (${n} cases — linear main-path node, name-only instruction)`
    : `Creation-edit Insert (${n} cases — name + type + between, no parameters)`;
}

export function bootstrapSheetFromManifest(manifest, op, target, existingSheet = { cases: [] }) {
  const cases = op === 'delete' ? manifest.delete_cases || [] : manifest.insert_cases || [];
  const benchmarkRoot = dirname(dirname(new URL(import.meta.url).pathname));
  const byId = Object.fromEntries((existingSheet.cases || []).map((r) => [r.caseId, r]));
  for (const caseEntry of cases) {
    const instruction = instructionForCase(benchmarkRoot, caseEntry);
    const prev = byId[caseEntry.id] || {};
    byId[caseEntry.id] = sheetRow(caseEntry, {
      workflowId: prev.workflowId || '',
      workflowUrl: prev.workflowUrl || '',
      instruction,
    });
  }
  const sheet = {
    ...existingSheet,
    target,
    baseUrl: existingSheet.baseUrl || (target === 'local' ? 'http://localhost:5678' : ''),
    mode: `manual_creation_edit_${op}`,
    dataset: 'creation_edit_paired',
    cases: Object.values(byId).sort((a, b) => a.caseId.localeCompare(b.caseId)),
    preparedAt: new Date().toISOString(),
  };
  return sheet;
}

export function mergeSheetCases(sheet, rows) {
  const byId = Object.fromEntries((sheet.cases || []).map((r) => [r.caseId, r]));
  for (const row of rows) byId[row.caseId] = { ...byId[row.caseId], ...row };
  sheet.cases = Object.values(byId).sort((a, b) => a.caseId.localeCompare(b.caseId));
  sheet.preparedAt = new Date().toISOString();
  return sheet;
}

export function writeMarkdownSheet(sheet, op, target, paths) {
  const cfg = SHEET_CONFIG[op];
  const isLocal = target === 'local';
  const baseUrl = sheet.baseUrl || '';
  const title = sheetTitle(op, (sheet.cases || []).length);

  const lines = [
    `# ${isLocal ? 'Local' : 'Cloud'} — ${title}`,
    '',
    `**${isLocal ? 'Local n8n' : 'Cloud'}:** ${baseUrl}`,
    '',
    isLocal
      ? 'For each row: open **Workflow URL** in local n8n, open the **chat widget**, paste **Instruction** (text only), wait until done, **Save** workflow.'
      : 'For each row: open **Workflow URL**, open **AI Builder**, paste **Instruction** (text only), wait until done, **Save**.',
    '',
    `Full instructions: \`${cfg.instructionDir}/<case>/instruction.txt\``,
    '',
    '| Done | Case | Source create | Complexity | Gold name | GT nodes | Target node | Workflow URL | Instruction |',
    '|------|------|---------------|------------|-----------|----------|-------------|--------------|-------------|',
  ];

  for (const row of sheet.cases) {
    const instr = String(row.instruction || '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
    lines.push(
      `| [ ] | ${row.caseId} | ${row.sourceCreateId || ''} | ${row.complexity || ''} | ${String(row.goldName || '').replace(/\|/g, '\\|')} | ${row.gtNodes ?? '?'} | ${String(row.targetNode || '').replace(/\|/g, '\\|')} | ${row.workflowUrl} | ${instr} |`
    );
  }

  lines.push('', 'After all runs:', '', '```bash');
  if (isLocal) {
    lines.push(
      `BENCHMARK_MANIFEST=data/manifest_creation_edit.json node run_local.mjs --operation ${cfg.scoringOp} --force`
    );
  } else {
    lines.push(`node manual_creation_edit_cloud.mjs fetch ${op} --force`);
  }
  lines.push('```');

  writeFileSync(paths[op].md, lines.join('\n'), 'utf8');
}
