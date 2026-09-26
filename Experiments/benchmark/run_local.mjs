#!/usr/bin/env node
/**
 * Batch-run benchmark cases against the local chatbot agent (POST /agent/run).
 *
 * Usage:
 *   node run_local.mjs --operation delete --limit 5
 *   node run_local.mjs --case-id delete-001
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadManifest, filterCases, sleep, resolveKeepWorkflow } from './lib/args.mjs';
import {
  promptInstruction,
  instructionWithLocation,
  formatResultTag,
  formatInsertDetailLines,
} from './lib/result-tag.mjs';
import {
  stripWorkflowForImport,
  createWorkflow,
  getWorkflow,
  deleteWorkflow,
  waitForPersistedWorkflow,
} from './lib/n8n-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;

const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(
  /\/$/,
  ''
).replace('http://n8n:5678', 'http://localhost:5678');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const CHAT_AGENT_URL = process.env.CHAT_AGENT_URL || 'http://localhost:3001/agent/run';
const BENCHMARK_RESULTS_TAG = String(process.env.BENCHMARK_RESULTS_TAG || '').trim();
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3.12';
const MANIFEST_PATH = resolve(BENCHMARK_ROOT, process.env.BENCHMARK_MANIFEST || 'data/manifest.json');
const RESULTS_ROOT = resolve(BENCHMARK_ROOT, 'results/local');

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

async function runAgent(instruction, workflowId) {
  const r = await fetch(CHAT_AGENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: instruction,
      workflowId,
      clearSession: true,
    }),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`agent non-JSON ${r.status}: ${text.slice(0, 400)}`);
  }
  if (!r.ok || !body.ok) {
    throw new Error(body.error || `agent HTTP ${r.status}`);
  }
  return body;
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
    {
      env: { ...process.env },
      encoding: 'utf8',
    }
  );
  let score = null;
  if (existsSync(outScorePath)) {
    try {
      score = JSON.parse(readFileSync(outScorePath, 'utf8'));
    } catch {
      score = null;
    }
  }
  return { ok: proc.status === 0, score };
}

function resultDir(caseEntry) {
  const caseId = caseEntry.id || '';
  if (caseId.startsWith('create-ins-')) {
    const bucket = BENCHMARK_RESULTS_TAG ? `create-ins-${BENCHMARK_RESULTS_TAG}` : 'insert';
    return join(RESULTS_ROOT, bucket, caseId);
  }
  if (caseId.startsWith('create-del-')) {
    const bucket = BENCHMARK_RESULTS_TAG ? `create-del-${BENCHMARK_RESULTS_TAG}` : 'delete';
    return join(RESULTS_ROOT, bucket, caseId);
  }
  const op = caseEntry.scoring_operation || caseEntry.operation;
  return join(RESULTS_ROOT, op, caseId);
}

function scoringOperation(caseEntry) {
  return caseEntry.scoring_operation || caseEntry.operation;
}

function resolveInstruction(caseEntry, includeLocation) {
  if (includeLocation) {
    return instructionWithLocation(caseEntry);
  }
  return promptInstruction(caseEntry);
}

async function runOneCase(caseEntry, { dryRun, skipScore, keepWorkflow, force, includeLocation }) {
  const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
  const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);
  const outDir = resultDir(caseEntry);
  ensureDir(outDir);

  const metaPath = join(outDir, 'meta.json');
  if (
    !force &&
    existsSync(join(outDir, 'pred.json')) &&
    existsSync(join(outDir, 'score.json'))
  ) {
    console.log(`[skip] ${caseEntry.id} already has pred+score`);
    return { skipped: true, caseId: caseEntry.id };
  }

  const base = readJson(basePath);
  const instruction = resolveInstruction(caseEntry, includeLocation);
  if (!instruction) {
    throw new Error(`Missing instruction for ${caseEntry.id}`);
  }

  if (dryRun) {
    console.log(`[dry-run] ${caseEntry.id}: ${instruction.slice(0, 80)}...`);
    return { dryRun: true, caseId: caseEntry.id };
  }

  if (!N8N_API_KEY) {
    throw new Error('N8N_API_KEY is required for local benchmark');
  }

  const started = Date.now();
  let workflowId = null;
  const meta = {
    caseId: caseEntry.id,
    operation: caseEntry.operation,
    model: process.env.BENCHMARK_MODEL || process.env.OPENAI_MODEL || null,
    resultsTag: BENCHMARK_RESULTS_TAG || null,
    startedAt: new Date().toISOString(),
    instructionSent: instruction,
    ...(includeLocation ? { instructionMode: 'include-location' } : {}),
  };

  try {
    const doc = stripWorkflowForImport(base, `bench-${caseEntry.id}`);
    const created = await createWorkflow(N8N_BASE_URL, N8N_API_KEY, doc);
    workflowId = created.id;
    meta.workflowId = workflowId;

    const agentOut = await runAgent(instruction, workflowId);
    meta.agentAction = agentOut.action;
    meta.agentMessage = agentOut.message;

    const persist = await waitForPersistedWorkflow(N8N_BASE_URL, N8N_API_KEY, workflowId, base, {
      timeoutMs: Number(process.env.PERSIST_TIMEOUT_MS || 60000),
    });
    meta.persist = {
      persisted: persist.persisted,
      attempts: persist.attempts,
      elapsedMs: persist.elapsedMs,
    };

    let pred = persist.workflow;
    if (agentOut.workflow?.nodes && !persist.persisted) {
      pred = agentOut.workflow;
    }

    const predPath = join(outDir, 'pred.json');
    writeJson(predPath, pred);
    meta.elapsedMs = Date.now() - started;
    writeJson(metaPath, meta);

    if (!skipScore) {
      const scorePath = join(outDir, 'score.json');
      const { ok, score } = scoreCase(
        scoringOperation(caseEntry),
        basePath,
        goldPath,
        predPath,
        caseEntry,
        scorePath
      );
      meta.scoredSuccess = ok;
      if (score?.insert_status_label) {
        meta.insertStatus = score.insert_status_label;
        meta.insertTier = score.insert_status || score.insert_tier;
      }
      writeJson(metaPath, meta);
      const tag = formatResultTag({
        operation: caseEntry.operation,
        score,
        meta,
      });
      console.log(`[${tag}] ${caseEntry.id} (${meta.elapsedMs}ms)`);
      if (score?.insert_status_label && caseEntry.operation?.startsWith('insert')) {
        console.log(`  insert: ${score.insert_status_label} (${score.insert_status || score.insert_tier})`);
        if (score.insert_detail?.summary_zh) {
          console.log(`  ${score.insert_detail.summary_zh}`);
        }
        for (const line of formatInsertDetailLines(score)) {
          console.log(line);
        }
      }
      return { caseId: caseEntry.id, success: ok, insertStatus: score?.insert_status_label };
    }

    console.log(`[done] ${caseEntry.id} (no score)`);
    return { caseId: caseEntry.id };
  } catch (err) {
    meta.error = err.message || String(err);
    meta.elapsedMs = Date.now() - started;
    writeJson(metaPath, meta);
    console.error(`[error] ${caseEntry.id}: ${meta.error}`);
    return { caseId: caseEntry.id, error: meta.error };
  } finally {
    if (workflowId) {
      if (keepWorkflow) {
        meta.workflowKept = true;
        meta.workflowDeleted = false;
        meta.workflowUrl = `${N8N_BASE_URL.replace(/\/$/, '')}/workflow/${workflowId}`;
        writeJson(metaPath, meta);
        console.log(`  workflow kept: ${meta.workflowUrl}`);
      } else {
        try {
          await deleteWorkflow(N8N_BASE_URL, N8N_API_KEY, workflowId);
          meta.workflowDeleted = true;
          meta.workflowKept = false;
        } catch (e) {
          meta.workflowDeleted = false;
          meta.workflowDeleteError = e.message || String(e);
          console.warn(`  workflow cleanup failed (${workflowId}): ${meta.workflowDeleteError}`);
        }
        writeJson(metaPath, meta);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`Missing manifest. Run: npm run prepare-data\n  ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = loadManifest(MANIFEST_PATH);
  const cases = filterCases(manifest, {
    operation: args.operation || 'all',
    limit: args.limit,
    offset: args.offset,
    caseId: args['case-id'],
  });

  console.log(`Running ${cases.length} cases via ${CHAT_AGENT_URL}`);
  const stats = { ok: 0, fail: 0, err: 0, skip: 0 };

  for (const c of cases) {
    const res = await runOneCase(c, {
      dryRun: !!args['dry-run'],
      skipScore: !!args['skip-score'],
      keepWorkflow: resolveKeepWorkflow(args),
      force: !!args.force,
      includeLocation: !!args['include-location'],
    });
    if (res.skipped) stats.skip += 1;
    else if (res.error) stats.err += 1;
    else if (res.success === true) stats.ok += 1;
    else if (res.success === false) stats.fail += 1;
    await sleep(Number(args.delay || 500));
  }

  console.log('Summary:', stats);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
