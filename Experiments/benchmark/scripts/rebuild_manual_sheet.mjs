#!/usr/bin/env node
/** Rebuild manual_run_sheet from cloud insert-partial meta.json files. */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD_INSERT = join(ROOT, 'results/cloud/insert');
const SHEET_JSON = join(ROOT, 'manual_run_sheet.json');
const SHEET_MD = join(ROOT, 'manual_run_sheet.md');
const CLOUD_URL = (process.env.N8N_CLOUD_URL || 'https://widmn8n.app.n8n.cloud').replace(/\/$/, '');

const ORDER = [
  '001', '002', '003', '004', '005', '006', '007', '008', '009',
  '015', '016', '018', '019', '041', '046', '047', '048', '054',
  '065', '069', '071', '082',
];

const rows = [];
for (const suffix of ORDER) {
  const id = `insert-partial-${suffix}`;
  const metaPath = join(CLOUD_INSERT, id, 'meta.json');
  if (!existsSync(metaPath)) {
    console.warn(`[skip] no meta: ${id}`);
    continue;
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  rows.push({
    caseId: id,
    workflowId: meta.workflowId,
    workflowUrl: meta.workflowUrl || `${CLOUD_URL}/workflow/${meta.workflowId}`,
    instruction: meta.instructionSent || '',
    status: 'prepared',
  });
}

const sheet = {
  cloudUrl: CLOUD_URL,
  preparedAt: new Date().toISOString(),
  mode: 'manual_ai_builder',
  cases: rows,
};
writeFileSync(SHEET_JSON, JSON.stringify(sheet, null, 2));

const lines = [
  '# Manual Cloud AI Builder — insert-partial study set',
  '',
  `Cloud: ${sheet.cloudUrl}`,
  '',
  'For each row: open **Workflow URL**, open AI Builder, paste **Instruction** (text only), wait until done, save workflow.',
  '',
  '| Done | Case | Workflow URL | Instruction |',
  '|------|------|--------------|-------------|',
];
for (const row of rows) {
  const instr = String(row.instruction || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  lines.push(`| [ ] | ${row.caseId} | ${row.workflowUrl} | ${instr} |`);
}
lines.push('', 'After edits: `node manual_cloud.mjs fetch --operation insert-partial --pilot`');
writeFileSync(SHEET_MD, lines.join('\n'), 'utf8');
console.log(`Wrote ${rows.length} cases to manual_run_sheet`);
