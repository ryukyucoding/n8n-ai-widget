#!/usr/bin/env node
/**
 * Local creation-edit run sheets + workflow import for manual widget testing.
 *
 *   node manual_creation_edit_local.mjs prepare delete [--force]
 *   node manual_creation_edit_local.mjs prepare insert [--force]
 *   node manual_creation_edit_local.mjs prepare all [--force]
 *     → import base.json to local n8n, write creation_*_run_sheet_local.md/json
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { stripWorkflowForImport, createWorkflow } from './lib/n8n-api.mjs';
import {
  SHEET_CONFIG,
  pathsForTarget,
  loadManifest,
  instructionForCase,
  sheetRow,
  mergeSheetCases,
  writeMarkdownSheet,
  writeJson,
} from './lib/creation_edit_run_sheet.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;
const LOCAL_URL = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
const LOCAL_API_KEY = process.env.N8N_API_KEY || '';
const RESULTS_ROOT = resolve(BENCHMARK_ROOT, 'results/local');
const PATHS = pathsForTarget('local');

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function casesForOp(manifest, op) {
  if (op === 'delete') return manifest.delete_cases || [];
  if (op === 'insert') return manifest.insert_cases || [];
  return [];
}

function filterEditCases(cases, { limit, offset, caseId }) {
  let out = cases;
  if (caseId) out = out.filter((c) => c.id === caseId);
  const off = Number(offset || 0);
  const lim = limit != null ? Number(limit) : out.length;
  return out.slice(off, off + lim);
}

async function cmdPrepare(op, cases, { force }) {
  if (!LOCAL_API_KEY) throw new Error('N8N_API_KEY required in Experiments/benchmark/.env');

  const sheetPath = PATHS[op];
  const sheet = existsSync(sheetPath.json) ? JSON.parse(readFileSync(sheetPath.json, 'utf8')) : { cases: [] };
  const cfg = SHEET_CONFIG[op];
  const batchRows = [];

  for (const caseEntry of cases) {
    const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
    const outDir = join(RESULTS_ROOT, cfg.resultOp, caseEntry.id);
    const metaPath = join(outDir, 'meta.json');
    ensureDir(outDir);

    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    const instruction = instructionForCase(BENCHMARK_ROOT, caseEntry);
    let meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

    if (meta.workflowId && meta.mode === `manual_local_${op}` && !force) {
      console.log(`[keep] ${caseEntry.id} → ${meta.workflowUrl}`);
      batchRows.push(
        sheetRow(caseEntry, {
          workflowId: meta.workflowId,
          workflowUrl: meta.workflowUrl,
          instruction,
        })
      );
      continue;
    }

    const doc = stripWorkflowForImport(base, `local-${caseEntry.id}`);
    const created = await createWorkflow(LOCAL_URL, LOCAL_API_KEY, doc);
    const workflowUrl = `${LOCAL_URL}/workflow/${created.id}`;

    meta = {
      caseId: caseEntry.id,
      operation: caseEntry.operation,
      mode: `manual_local_${op}`,
      preparedAt: new Date().toISOString(),
      workflowId: created.id,
      workflowUrl,
      instructionSent: instruction,
      sourceCreateId: caseEntry.source_create_id,
      workflowKept: true,
    };
    writeJson(metaPath, meta);

    batchRows.push(
      sheetRow(caseEntry, {
        workflowId: created.id,
        workflowUrl,
        instruction,
      })
    );
    console.log(`[import] ${caseEntry.id} → ${workflowUrl}`);
  }

  sheet.target = 'local';
  sheet.baseUrl = LOCAL_URL;
  sheet.mode = `manual_creation_edit_${op}`;
  sheet.dataset = 'creation_edit_paired';
  mergeSheetCases(sheet, batchRows);
  writeJson(sheetPath.json, sheet);
  writeMarkdownSheet(sheet, op, 'local', PATHS);
  console.log(`\nWrote ${sheetPath.json}`);
  console.log(`Wrote ${sheetPath.md}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!sub || !['prepare'].includes(sub)) {
    console.error('Usage: node manual_creation_edit_local.mjs prepare delete|insert|all [--force]');
    process.exit(1);
  }

  const opArg = argv[1];
  const ops =
    opArg === 'all' ? ['delete', 'insert'] : opArg === 'delete' || opArg === 'insert' ? [opArg] : null;
  if (!ops) {
    console.error('Specify operation: delete | insert | all');
    process.exit(1);
  }

  const manifest = loadManifest(BENCHMARK_ROOT);
  for (const op of ops) {
    const cases = filterEditCases(casesForOp(manifest, op), {
      limit: args.limit,
      offset: args.offset,
      caseId: args['case-id'],
    });
    console.log(`Local ${op} prepare: ${cases.length} cases → ${LOCAL_URL}`);
    await cmdPrepare(op, cases, { force: !!args.force });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
