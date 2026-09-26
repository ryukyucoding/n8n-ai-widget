#!/usr/bin/env node
/**
 * Creation-edit benchmark via base-model one-shot (no chatbot pipeline).
 *
 *   OPENAI_MODEL=gpt-4.1 node run_local_creation_edit.mjs --operation insert --limit 30
 *   OPENAI_MODEL=gpt-4.1 node run_local_creation_edit.mjs --operation delete --limit 30
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadManifest, filterCases, sleep } from './lib/args.mjs';
import {
  RETRY_USER_APPEND,
  detectRunaway,
  tryStickySalvage,
} from './lib/creation-guardrails.mjs';
import { normalizePredWorkflow } from './lib/score-creation.mjs';
import { modelSlugForResults } from './lib/model-slug.mjs';
import { instructionForCase, SHEET_CONFIG } from './lib/creation_edit_run_sheet.mjs';
import {
  formatInsertDetailLines,
  formatResultTag,
} from './lib/result-tag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;

loadEnv({ path: resolve(BENCHMARK_ROOT, '../../../n8n_json_schema/.env'), override: false });

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MANIFEST_PATH = resolve(
  BENCHMARK_ROOT,
  process.env.BENCHMARK_MANIFEST || 'data/manifest_creation_edit.json'
);
const DEFAULT_VENV_PY = resolve(BENCHMARK_ROOT, '.venv/bin/python');
const PYTHON_BIN =
  process.env.PYTHON_BIN || (existsSync(DEFAULT_VENV_PY) ? DEFAULT_VENV_PY : 'python3.12');

const MAX_OUTPUT_TOKENS = Number(process.env.EDIT_MAX_OUTPUT_TOKENS || 16384);
const MAX_OUTPUT_TOKENS_LOW = Number(process.env.EDIT_MAX_OUTPUT_TOKENS_LOW || 8192);
const MAX_CONTINUATIONS = Number(process.env.EDIT_MAX_CONTINUATIONS || 2);
const MAX_GENERATION_RETRIES = Number(process.env.EDIT_MAX_RETRIES || 2);
const CONTINUATION_USER = `Your previous assistant message was cut off before the n8n workflow JSON was complete. Continue outputting ONLY the remaining characters needed to finish ONE valid JSON workflow object. Do not repeat earlier content. Do not use markdown fences.`;

const SYSTEM_PROMPT_EDIT = `You are an expert n8n workflow editor.
The user provides the current workflow as JSON and a single edit instruction.
Apply ONLY that edit. Return ONE complete valid n8n workflow JSON object — no markdown fences, no explanation.

Rules:
1. Preserve unchanged nodes (same id, name, type, parameters, position) unless the edit requires changes.
2. "connections" keys and target "node" values must use node "name" strings, not ids.
3. When inserting a node, wire it on the main execution path as described.
4. When deleting a node, bridge incoming and outgoing main connections like the n8n editor.`;

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

function manifestWithCases(raw) {
  if (raw.cases?.length) return raw;
  return {
    ...raw,
    cases: [...(raw.delete_cases || []), ...(raw.insert_cases || [])],
  };
}

function resultsRootForEditOneshot(operation, model) {
  const slug = modelSlugForResults(model);
  const tag = String(process.env.BENCHMARK_RESULTS_TAG || '').trim();
  const suffix = tag || `${slug}-oneshot`;
  const bucket =
    operation === 'insert' ? `create-ins-${suffix}` : `create-del-${suffix}`;
  return resolve(BENCHMARK_ROOT, 'results/local', bucket);
}

function parseWorkflowText(text, { allowRepair = false } = {}) {
  const args = [join(BENCHMARK_ROOT, 'dataset/parse_workflow_json.py')];
  if (!allowRepair) args.push('--strict');
  const proc = spawnSync(PYTHON_BIN, args, {
    input: String(text || ''),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    return { workflow: null, parseNote: (proc.stderr || proc.stdout || '').trim(), strict: false };
  }
  try {
    const out = JSON.parse(proc.stdout || '{}');
    return {
      workflow: out.workflow || null,
      parseNote: out.parse_note || null,
      strict: !!out.strict,
    };
  } catch {
    return { workflow: null, parseNote: 'parse_helper_invalid_json', strict: false };
  }
}

async function chatCompletion(messages, { temperature = 0, maxTokens = MAX_OUTPUT_TOKENS } = {}) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.error?.message || `OpenAI HTTP ${r.status}`);
  }
  const choice = body.choices?.[0] || {};
  return {
    raw: choice.message?.content ?? '',
    finishReason: choice.finish_reason || '',
    usage: body.usage || {},
  };
}

function mergeUsage(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (typeof v === 'number' && typeof out[k] === 'number') out[k] += v;
    else out[k] = v;
  }
  return out;
}

function generationTemperature(generationAttempt) {
  if (generationAttempt <= 0) return 0;
  if (generationAttempt === 1) return 0.4;
  return 0.7;
}

function maxTokensForCase(complexity) {
  return complexity === 'low' ? MAX_OUTPUT_TOKENS_LOW : MAX_OUTPUT_TOKENS;
}

function buildGenerationError({
  finishReason,
  segments,
  accumulated,
  parseNote,
  usage,
  runaway,
  generationAttempt,
}) {
  const err = new Error(
    `Model output is not valid workflow JSON (finish=${finishReason}, segments=${segments}, len=${accumulated.length}, note=${parseNote || 'none'}${runaway?.reason ? `, runaway=${runaway.reason}` : ''}): ${accumulated.slice(0, 200)}`
  );
  err.raw = accumulated;
  err.usage = usage;
  err.finishReason = finishReason;
  err.segments = segments;
  err.parseNote = parseNote;
  err.runaway = !!runaway?.runaway;
  err.runawayReason = runaway?.reason || null;
  err.generationAttempt = generationAttempt;
  return err;
}

async function callModelOnce(system, user, { generationAttempt = 0, complexity = 'med' } = {}) {
  const temperature = generationTemperature(generationAttempt);
  const maxTokens = maxTokensForCase(complexity);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let accumulated = '';
  let usage = {};
  let finishReason = '';
  let segments = 0;
  let parseNote = null;
  let runaway = { runaway: false };

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt += 1) {
    const part = await chatCompletion(messages, { temperature, maxTokens });
    accumulated += part.raw;
    usage = mergeUsage(usage, part.usage);
    finishReason = part.finishReason;
    segments += 1;

    runaway = detectRunaway(accumulated);
    if (runaway.runaway) {
      finishReason = 'runaway';
      parseNote = runaway.reason;
      break;
    }

    const parsed = parseWorkflowText(accumulated, { allowRepair: false });
    if (parsed.workflow?.nodes && parsed.strict) {
      return {
        workflow: parsed.workflow,
        raw: accumulated,
        usage,
        finishReason,
        segments,
        parseNote: parsed.parseNote,
        strictParse: true,
        generationAttempt,
        temperature,
        maxTokens,
      };
    }
    parseNote = parsed.parseNote;

    const shouldContinue =
      attempt < MAX_CONTINUATIONS &&
      (finishReason === 'length' || finishReason === 'max_tokens') &&
      !detectRunaway(accumulated).runaway;
    if (!shouldContinue) break;

    messages.push({ role: 'assistant', content: accumulated.slice(-8000) });
    messages.push({
      role: 'user',
      content: `${CONTINUATION_USER}\n\nThe JSON fragment above ends mid-document. Continue with the very next character and output only the suffix needed to complete the single workflow JSON object.`,
    });
  }

  if (runaway.runaway) {
    throw buildGenerationError({
      finishReason,
      segments,
      accumulated,
      parseNote,
      usage,
      runaway,
      generationAttempt,
    });
  }

  const repaired = parseWorkflowText(accumulated, { allowRepair: true });
  if (repaired.workflow?.nodes?.length && repaired.strict) {
    return {
      workflow: repaired.workflow,
      raw: accumulated,
      usage,
      finishReason,
      segments,
      parseNote: repaired.parseNote,
      strictParse: true,
      generationAttempt,
      temperature,
      maxTokens,
    };
  }

  const salvaged = tryStickySalvage(repaired.workflow);
  if (salvaged) {
    return {
      workflow: salvaged.workflow,
      raw: accumulated,
      usage,
      finishReason,
      segments,
      parseNote: salvaged.parseNote,
      strictParse: salvaged.strictParse,
      droppedSticky: salvaged.droppedSticky,
      generationAttempt,
      temperature,
      maxTokens,
    };
  }

  if (
    repaired.workflow?.nodes?.length &&
    repaired.parseNote === 'json_repair' &&
    finishReason === 'stop' &&
    accumulated.length < 20000
  ) {
    return {
      workflow: repaired.workflow,
      raw: accumulated,
      usage,
      finishReason,
      segments,
      parseNote: repaired.parseNote,
      strictParse: false,
      generationAttempt,
      temperature,
      maxTokens,
    };
  }

  throw buildGenerationError({
    finishReason,
    segments,
    accumulated,
    parseNote: repaired.parseNote || parseNote,
    usage,
    runaway,
    generationAttempt,
  });
}

function isRetryableGenerationError(err) {
  if (!err) return false;
  if (err.runaway) return true;
  if (err.finishReason === 'length' || err.finishReason === 'runaway') return true;
  if ((err.raw?.length || 0) >= 20000) return true;
  return false;
}

async function callModelWithRetries(system, user, caseEntry) {
  let lastErr;
  for (let generationAttempt = 0; generationAttempt <= MAX_GENERATION_RETRIES; generationAttempt += 1) {
    const userMsg =
      generationAttempt === 0 ? user : `${user}${RETRY_USER_APPEND}`;
    try {
      return await callModelOnce(system, userMsg, {
        generationAttempt,
        complexity: caseEntry.complexity,
      });
    } catch (err) {
      lastErr = err;
      const canRetry =
        generationAttempt < MAX_GENERATION_RETRIES && isRetryableGenerationError(err);
      if (!canRetry) throw err;
      console.log(
        `[retry] ${caseEntry.id} gen ${generationAttempt + 1}/${MAX_GENERATION_RETRIES} ` +
          `(${err.runawayReason || err.parseNote || err.finishReason}, len=${err.raw?.length ?? 0})`
      );
      await sleep(Number(process.env.EDIT_RETRY_DELAY_MS || 500));
    }
  }
  throw lastErr;
}

function buildEditUser(baseWorkflow, instruction) {
  return `Instruction:\n${instruction.trim()}\n\nCurrent workflow JSON:\n${JSON.stringify(baseWorkflow)}`;
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
      score = JSON.parse(readFileSync(outScorePath, 'utf8'));
    } catch {
      score = null;
    }
  }
  return { ok: proc.status === 0, score };
}

async function runOneCase(caseEntry, { force, dryRun, resultsRoot, operation }) {
  const cfg = SHEET_CONFIG[operation];
  const scoringOp = cfg.scoringOp;
  const outDir = join(resultsRoot, caseEntry.id);
  ensureDir(outDir);
  const predPath = join(outDir, 'pred.json');
  const scorePath = join(outDir, 'score.json');
  const metaPath = join(outDir, 'meta.json');
  const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
  const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);

  if (!force && existsSync(predPath) && existsSync(scorePath)) {
    console.log(`[skip] ${caseEntry.id} already scored`);
    return { skipped: true };
  }

  const baseWorkflow = readJson(basePath);
  const instruction = instructionForCase(BENCHMARK_ROOT, caseEntry);
  const user = buildEditUser(baseWorkflow, instruction);

  if (dryRun) {
    console.log(`[dry-run] ${caseEntry.id} model=${OPENAI_MODEL}`);
    return { dryRun: true };
  }

  const started = Date.now();
  try {
    const gen = await callModelWithRetries(SYSTEM_PROMPT_EDIT, user, caseEntry);
    const normalizedWorkflow = normalizePredWorkflow(gen.workflow);
    writeJson(predPath, normalizedWorkflow);
    writeFileSync(join(outDir, 'raw.txt'), gen.raw, 'utf8');

    const meta = {
      caseId: caseEntry.id,
      operation: caseEntry.operation,
      mode: 'local_gpt_oneshot_edit',
      model: OPENAI_MODEL,
      startedAt: new Date(started).toISOString(),
      elapsedMs: Date.now() - started,
      usage: gen.usage,
      finishReason: gen.finishReason,
      segments: gen.segments,
      parseNote: gen.parseNote,
      strictParse: gen.strictParse,
      instructionSent: instruction,
    };
    writeJson(metaPath, meta);

    const { ok, score } = scoreCase(
      scoringOp,
      basePath,
      goldPath,
      predPath,
      caseEntry,
      scorePath
    );
    meta.scoredSuccess = ok;
    meta.elapsedMs = Date.now() - started;
    if (score?.insert_status_label) {
      meta.insertStatus = score.insert_status_label;
    }
    writeJson(metaPath, meta);

    const tag = formatResultTag({
      operation: caseEntry.operation,
      score,
      meta,
    });
    console.log(`[${tag}] ${caseEntry.id} (${meta.elapsedMs}ms)`);
    if (operation === 'insert' && score?.insert_status_label) {
      console.log(`  insert: ${score.insert_status_label}`);
      for (const line of formatInsertDetailLines(score)) {
        console.log(line);
      }
    }
    return { ok: score?.success === true, score };
  } catch (err) {
    const meta = {
      caseId: caseEntry.id,
      operation: caseEntry.operation,
      mode: 'local_gpt_oneshot_edit',
      model: OPENAI_MODEL,
      error: err.message || String(err),
      elapsedMs: Date.now() - started,
    };
    if (err.raw) {
      writeFileSync(join(outDir, 'raw.txt'), err.raw, 'utf8');
      meta.rawLength = err.raw.length;
    }
    writeJson(metaPath, meta);
    console.error(`[error] ${caseEntry.id}: ${meta.error}`);
    return { error: meta.error };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const operation = String(args.operation || '').trim().toLowerCase();
  if (operation !== 'insert' && operation !== 'delete') {
    console.error('Usage: node run_local_creation_edit.mjs --operation insert|delete [--limit 30] [--force]');
    process.exit(1);
  }

  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY required');
    process.exit(1);
  }
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`Missing ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = manifestWithCases(loadManifest(MANIFEST_PATH));
  const cases = filterCases(manifest, {
    operation,
    limit: args.limit,
    offset: args.offset,
    caseId: args['case-id'],
  });
  const resultsRoot = resultsRootForEditOneshot(operation, OPENAI_MODEL);

  console.log(
    `Creation-edit one-shot: op=${operation}, n=${cases.length}, model=${OPENAI_MODEL}`
  );
  console.log(`Results: ${resultsRoot}`);

  const stats = { ok: 0, fail: 0, err: 0, skip: 0 };
  for (const c of cases) {
    const res = await runOneCase(c, {
      force: !!args.force,
      dryRun: !!args['dry-run'],
      resultsRoot,
      operation,
    });
    if (res.skipped) stats.skip += 1;
    else if (res.error) stats.err += 1;
    else if (res.ok) stats.ok += 1;
    else if (res.ok === false) stats.fail += 1;
    await sleep(Number(args.delay || 300));
  }
  console.log('Summary:', stats);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
