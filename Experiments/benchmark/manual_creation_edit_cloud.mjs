#!/usr/bin/env node
/**
 * Manual Cloud AI Builder — creation-edit delete/insert benchmark.
 *
 *   node manual_creation_edit_cloud.mjs prepare delete [--force]
 *   node manual_creation_edit_cloud.mjs prepare insert [--force]
 *   node manual_creation_edit_cloud.mjs prepare all [--force]
 *     → import base.json to Cloud, write run sheets
 *
 *   (paste instruction in AI Builder per row, save)
 *
 *   node manual_creation_edit_cloud.mjs fetch delete [--force]
 *   node manual_creation_edit_cloud.mjs fetch insert [--force]
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import {
  stripWorkflowForImport,
  createWorkflow,
  getWorkflow,
  workflowSignature,
} from './lib/n8n-api.mjs';
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
const CLOUD_URL = (process.env.N8N_CLOUD_URL || 'https://widmn8n.app.n8n.cloud').replace(/\/$/, '');
const CLOUD_API_KEY = process.env.N8N_CLOUD_API_KEY || '';
const RESULTS_ROOT = resolve(BENCHMARK_ROOT, 'results/cloud');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3.12';
const PATHS = pathsForTarget('cloud');

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
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
    { encoding: 'utf8' }
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

async function cmdPrepare(op, cases, { force }) {
  if (!CLOUD_API_KEY) throw new Error('N8N_CLOUD_API_KEY required');

  const sheetPath = PATHS[op];
  const cfg = SHEET_CONFIG[op];
  const sheet = existsSync(sheetPath.json) ? readJson(sheetPath.json) : { cases: [] };
  const batchRows = [];

  for (const caseEntry of cases) {
    const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
    const outDir = join(RESULTS_ROOT, cfg.resultOp, caseEntry.id);
    const metaPath = join(outDir, 'meta.json');
    ensureDir(outDir);

    const base = readJson(basePath);
    const instruction = instructionForCase(BENCHMARK_ROOT, caseEntry);
    let meta = existsSync(metaPath) ? readJson(metaPath) : {};

    if (meta.workflowId && meta.mode === `manual_${op}` && !force) {
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

    const doc = stripWorkflowForImport(base, `cloud-${caseEntry.id}`);
    const created = await createWorkflow(CLOUD_URL, CLOUD_API_KEY, doc);
    const workflowUrl = `${CLOUD_URL}/workflow/${created.id}`;

    meta = {
      caseId: caseEntry.id,
      operation: caseEntry.operation,
      mode: `manual_${op}`,
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

  sheet.target = 'cloud';
  sheet.baseUrl = CLOUD_URL;
  sheet.mode = `manual_creation_edit_${op}`;
  sheet.dataset = 'creation_edit_paired';
  mergeSheetCases(sheet, batchRows);
  writeJson(sheetPath.json, sheet);
  writeMarkdownSheet(sheet, op, 'cloud', PATHS);
  console.log(`\nWrote ${sheetPath.json}`);
  console.log(`Wrote ${sheetPath.md}`);
}

async function cmdFetch(op, cases, { force }) {
  if (!CLOUD_API_KEY) throw new Error('N8N_CLOUD_API_KEY required');

  const sheetPath = PATHS[op];
  const cfg = SHEET_CONFIG[op];
  const scoringOp = cfg.scoringOp;
  const sheet = existsSync(sheetPath.json) ? readJson(sheetPath.json) : { cases: [] };
  const byId = Object.fromEntries((sheet.cases || []).map((r) => [r.caseId, r]));

  for (const caseEntry of cases) {
    const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
    const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);
    const outDir = join(RESULTS_ROOT, cfg.resultOp, caseEntry.id);
    const metaPath = join(outDir, 'meta.json');
    const predPath = join(outDir, 'pred.json');
    const scorePath = join(outDir, 'score.json');

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

    const base = readJson(basePath);
    const baseSig = workflowSignature(base);
    let pred;
    try {
      pred = await getWorkflow(CLOUD_URL, CLOUD_API_KEY, workflowId);
    } catch (e) {
      console.error(`[error] ${caseEntry.id}: GET failed: ${e.message}`);
      continue;
    }

    const changed = workflowSignature(pred) !== baseSig;
    writeJson(predPath, pred);
    writeJson(metaPath, {
      ...meta,
      fetchedAt: new Date().toISOString(),
      workflowChangedFromBase: changed,
    });

    const { ok, score, stderr } = scoreCase(
      scoringOp,
      basePath,
      goldPath,
      predPath,
      caseEntry,
      scorePath
    );
    const success = score?.success;
    const tag = changed ? 'changed' : 'unchanged';
    console.log(`[${ok ? 'OK' : 'FAIL'}] ${caseEntry.id} ${tag} success=${success}`);
    if (stderr?.trim()) console.error(stderr.trim().slice(0, 400));

    if (byId[caseEntry.id]) {
      byId[caseEntry.id].fetchedAt = new Date().toISOString();
      byId[caseEntry.id].metrics = score?.metrics || {};
      byId[caseEntry.id].success = success;
      byId[caseEntry.id].changed = changed;
    }
  }

  sheet.cases = mergeSheetCases(sheet, cases.map((c) => byId[c.id]).filter(Boolean)).cases;
  sheet.fetchedAt = new Date().toISOString();
  writeJson(sheetPath.json, sheet);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const sub = argv[1];
  const args = parseArgs(argv.slice(2));

  if (!cmd || !['prepare', 'fetch'].includes(cmd)) {
    console.error(
      'Usage: node manual_creation_edit_cloud.mjs prepare|fetch delete|insert|all [--force]'
    );
    process.exit(1);
  }

  const manifest = loadManifest(BENCHMARK_ROOT);
  const ops =
    sub === 'all' ? ['delete', 'insert'] : sub === 'delete' || sub === 'insert' ? [sub] : null;
  if (!ops) {
    console.error('Specify operation: delete | insert | all');
    process.exit(1);
  }

  for (const op of ops) {
    const cases = filterEditCases(casesForOp(manifest, op), {
      limit: args.limit,
      offset: args.offset,
      caseId: args['case-id'],
    });
    console.log(`Cloud ${op} ${cmd}: ${cases.length} cases → ${CLOUD_URL}`);
    if (cmd === 'prepare') {
      await cmdPrepare(op, cases, { force: !!args.force });
    } else {
      await cmdFetch(op, cases, { force: !!args.force });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
