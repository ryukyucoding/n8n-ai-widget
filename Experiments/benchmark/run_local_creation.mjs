#!/usr/bin/env node
/**
 * Local creation benchmark via fine-tuned OpenAI model (S1 original-description format).
 *
 * Uses each case's prompt.json (system + user) — same messages as fine-tune inference.
 *
 *   node run_local_creation.mjs [--limit 30] [--case-id create-001] [--force]
 *   node run_local_creation.mjs --prompt-profile semantic [--limit 5]
 *   node run_local_creation.mjs --mode staged [--limit 3] [--force]   # plan→fill→validate (gpt-4o)
 *   node run_local_creation.mjs --mode staged --with-executability [--repair-on-execute]
 *   node run_local_creation.mjs from-inference [--force]   # import archived ft predictions
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
import {
  buildCreationPrompt,
  resolvePromptProfile,
  resultsRootForOneshot,
  resultsRootForProfile,
} from './lib/creation-prompt-profiles.mjs';
import { normalizePredWorkflow, scoreCreation } from './lib/score-creation.mjs';
import { measureExecutability, resolveN8nBaseUrl } from './lib/n8n-executability.mjs';
import {
  STAGED_DEFAULT_MODEL,
  callStagedCreation,
  readCaseInstruction,
  resultsRootStaged,
} from './lib/staged-creation.mjs';
import { estimateOpenAiCost, mergeCostRows } from './lib/openai-cost.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;

loadEnv({ path: resolve(BENCHMARK_ROOT, '../../../n8n_json_schema/.env'), override: false });

const DEFAULT_MODEL =
  'ft:gpt-4.1-2025-04-14:widm:s1-original-desc-41:DmUZN4iU';
const OPENAI_MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_MANIFEST = resolve(BENCHMARK_ROOT, 'data/manifest_creation.json');
const MANIFEST_300 = resolve(BENCHMARK_ROOT, 'data/manifest_creation_300.json');
const DEFAULT_VENV_PY = resolve(BENCHMARK_ROOT, '.venv/bin/python');
const PYTHON_BIN =
  process.env.PYTHON_BIN || (existsSync(DEFAULT_VENV_PY) ? DEFAULT_VENV_PY : 'python3.12');

function resolveManifestPath(args = {}) {
  const raw =
    args.manifest ||
    process.env.BENCHMARK_MANIFEST ||
    (args.scale === '300' || args['300'] ? 'data/manifest_creation_300.json' : 'data/manifest_creation.json');
  return resolve(BENCHMARK_ROOT, raw);
}

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

const MAX_OUTPUT_TOKENS = Number(process.env.CREATE_MAX_OUTPUT_TOKENS || 16384);
const MAX_OUTPUT_TOKENS_LOW = Number(process.env.CREATE_MAX_OUTPUT_TOKENS_LOW || 8192);
const MAX_CONTINUATIONS = Number(process.env.CREATE_MAX_CONTINUATIONS || 2);
const MAX_GENERATION_RETRIES = Number(process.env.CREATE_MAX_RETRIES || 2);
const CONTINUATION_USER = `Your previous assistant message was cut off before the n8n workflow JSON was complete. Continue outputting ONLY the remaining characters needed to finish ONE valid JSON workflow object. Do not repeat earlier content. Do not use markdown fences.`;

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

async function callFineTunedModel(system, user, { generationAttempt = 0, complexity = 'med' } = {}) {
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
      content:
        `${CONTINUATION_USER}\n\nThe JSON fragment above ends mid-document. Continue with the very next character and output only the suffix needed to complete the single workflow JSON object.`,
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

  // Allow json_repair only for small/medium outputs that stopped normally (syntax glitches).
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

async function callFineTunedModelWithRetries(system, user, caseEntry) {
  let lastErr;
  for (let generationAttempt = 0; generationAttempt <= MAX_GENERATION_RETRIES; generationAttempt += 1) {
    const userMsg =
      generationAttempt === 0 ? user : `${user}${RETRY_USER_APPEND}`;
    try {
      return await callFineTunedModel(system, userMsg, {
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
      await sleep(Number(process.env.CREATE_RETRY_DELAY_MS || 500));
    }
  }
  throw lastErr;
}

async function maybeMeasureExecutability({
  caseEntry,
  outDir,
  workflow,
  instruction,
  validationIssues,
  withExecutability,
  repairOnExecute,
}) {
  if (!withExecutability) return null;
  const execPath = join(outDir, 'executability.json');
  const row = await measureExecutability({
    workflow,
    caseId: caseEntry.id,
    baseUrl: resolveN8nBaseUrl(),
    repair: repairOnExecute,
    instruction,
    validationIssues,
  });
  writeJson(execPath, row);
  return row;
}

async function runOneCaseStaged(caseEntry, { force, dryRun, resultsRoot, withExecutability, repairOnExecute }) {
  const outDir = join(resultsRoot, caseEntry.id);
  ensureDir(outDir);
  const predPath = join(outDir, 'pred.json');
  const scorePath = join(outDir, 'score.json');
  const metaPath = join(outDir, 'meta.json');
  const trajectoryPath = join(outDir, 'trajectory.json');
  const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);

  if (!force && existsSync(predPath) && existsSync(scorePath)) {
    console.log(`[skip] ${caseEntry.id} already scored`);
    return { skipped: true };
  }

  const instruction = readCaseInstruction(BENCHMARK_ROOT, caseEntry);
  const model = process.env.OPENAI_MODEL || STAGED_DEFAULT_MODEL;

  if (dryRun) {
    console.log(`[dry-run] ${caseEntry.id} mode=staged model=${model}`);
    return { dryRun: true };
  }

  const started = Date.now();
  try {
    const result = callStagedCreation({
      instruction,
      model,
      apiKey: OPENAI_API_KEY,
      maxFixIterations: Number(process.env.STAGED_MAX_FIX_ITERATIONS || 2),
    });
    if (!result.ok || !result.workflow) {
      const meta = {
        caseId: caseEntry.id,
        operation: 'create',
        mode: 'staged',
        model,
        error: result.error || 'staged creation failed',
        elapsedMs: Date.now() - started,
      };
      writeJson(metaPath, meta);
      console.error(`[error] ${caseEntry.id}: ${meta.error}`);
      return { error: meta.error };
    }

    const normalizedWorkflow = normalizePredWorkflow(result.workflow);
    writeJson(predPath, normalizedWorkflow);
    writeJson(trajectoryPath, {
      plan: result.plan || null,
      node_specs: result.node_specs || null,
      trajectory: result.trajectory || [],
      validation_issues: result.validation_issues || [],
    });

    const usage = result.usage || {};
    const cost = estimateOpenAiCost(usage, model);
    const meta = {
      caseId: caseEntry.id,
      operation: 'create',
      mode: 'staged',
      model,
      startedAt: new Date(started).toISOString(),
      elapsedMs: Date.now() - started,
      usage,
      cost,
      planNodes: result.plan?.nodes?.length ?? 0,
      validationIssueCount: (result.validation_issues || []).length,
      complexity: caseEntry.complexity,
    };
    writeJson(metaPath, meta);

    const { ok, score, stderr } = scoreCreation({
      goldPath,
      predPath,
      outScorePath: scorePath,
      normalize: false,
    });
    const s = score?.summary || {};
    const execRow = await maybeMeasureExecutability({
      caseEntry,
      outDir,
      workflow: normalizedWorkflow,
      instruction,
      validationIssues: result.validation_issues || [],
      withExecutability,
      repairOnExecute,
    });
    console.log(
      `[${ok ? 'OK' : 'FAIL'}] ${caseEntry.id} staged (${meta.elapsedMs}ms)  ` +
        `node_f1=${s.node_f1 ?? '?'} conn_f1=${s.connection_f1 ?? '?'} ` +
        `matched_conn_f1=${s.matched_connection_f1 ?? '?'} param=${s.parameter_accuracy ?? '?'} ` +
        `val_issues=${meta.validationIssueCount} ` +
        `tokens=${cost.total_tokens} ($${cost.total_usd.toFixed(4)})` +
        (execRow
          ? ` exec=${execRow.final_execute_success ? 'ok' : execRow.final_execute_status}`
          : '')
    );
    if (stderr?.trim()) console.error(stderr.trim().slice(0, 300));
    return { ok, score };
  } catch (err) {
    console.error(`[error] ${caseEntry.id}: ${err.message || err}`);
    return { error: err.message || String(err) };
  }
}

async function runOneCase(caseEntry, { force, dryRun, promptProfile, resultsRoot, oneshotMode = 'local_finetune', withExecutability, repairOnExecute }) {
  const outDir = join(resultsRoot, caseEntry.id);
  ensureDir(outDir);
  const predPath = join(outDir, 'pred.json');
  const scorePath = join(outDir, 'score.json');
  const metaPath = join(outDir, 'meta.json');
  const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);

  if (!force && existsSync(predPath) && existsSync(scorePath)) {
    console.log(`[skip] ${caseEntry.id} already scored`);
    return { skipped: true };
  }

  const { system, user } = buildCreationPrompt(BENCHMARK_ROOT, caseEntry, promptProfile);

  if (dryRun) {
    console.log(`[dry-run] ${caseEntry.id} model=${OPENAI_MODEL}`);
    return { dryRun: true };
  }

  const started = Date.now();
  try {
    const {
      workflow,
      raw,
      usage,
      finishReason,
      segments,
      parseNote,
      strictParse,
      generationAttempt = 0,
      temperature,
      maxTokens,
      droppedSticky,
    } = await callFineTunedModelWithRetries(system, user, caseEntry);
    const normalizedWorkflow = normalizePredWorkflow(workflow);
    writeJson(predPath, normalizedWorkflow);
    writeFileSync(join(outDir, 'raw.txt'), raw, 'utf8');

    const meta = {
      caseId: caseEntry.id,
      operation: 'create',
      mode: oneshotMode,
      promptProfile,
      model: OPENAI_MODEL,
      startedAt: new Date(started).toISOString(),
      elapsedMs: Date.now() - started,
      usage,
      finishReason,
      segments,
      parseNote,
      strictParse,
      rawLength: raw.length,
      maxOutputTokens: maxTokens ?? maxTokensForCase(caseEntry.complexity),
      generationAttempt,
      temperature,
      droppedSticky,
      complexity: caseEntry.complexity,
    };
    writeJson(metaPath, meta);

    const { ok, score, stderr } = scoreCreation({
      goldPath,
      predPath,
      outScorePath: scorePath,
      normalize: false,
    });
    const s = score?.summary || {};
    const execRow = await maybeMeasureExecutability({
      caseEntry,
      outDir,
      workflow: normalizedWorkflow,
      instruction: '',
      validationIssues: null,
      withExecutability,
      repairOnExecute,
    });
    console.log(
      `[${ok ? 'OK' : 'FAIL'}] ${caseEntry.id} (${meta.elapsedMs}ms)  ` +
        `node_f1=${s.node_f1 ?? '?'} conn_f1=${s.connection_f1 ?? '?'} ` +
        `matched_conn_f1=${s.matched_connection_f1 ?? '?'} param=${s.parameter_accuracy ?? '?'} ` +
        (execRow
          ? ` exec=${execRow.final_execute_success ? 'ok' : execRow.final_execute_status}`
          : '')
    );
    if (stderr?.trim()) console.error(stderr.trim().slice(0, 300));
    return { ok, score };
  } catch (err) {
    const meta = {
      caseId: caseEntry.id,
      operation: 'create',
      mode: oneshotMode,
      promptProfile,
      model: OPENAI_MODEL,
      error: err.message || String(err),
      elapsedMs: Date.now() - started,
      finishReason: err.finishReason,
      segments: err.segments,
      parseNote: err.parseNote,
      runaway: err.runaway,
      runawayReason: err.runawayReason,
      generationAttempt: err.generationAttempt,
      usage: err.usage,
      rawLength: err.raw?.length,
      maxOutputTokens: maxTokensForCase(caseEntry.complexity),
    };
    writeJson(metaPath, meta);
    if (err.raw) {
      writeFileSync(join(outDir, 'raw.txt'), err.raw, 'utf8');
    }
    console.error(`[error] ${caseEntry.id}: ${err.message || err}`);
    return { error: err.message || String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolveManifestPath(args);
  if (manifestPath.includes('manifest_creation_300')) {
    process.env.BENCHMARK_SCALE = '300';
  }
  const cmd = args._[0];

  if (cmd === 'from-inference') {
    const proc = spawnSync(
      PYTHON_BIN,
      [join(BENCHMARK_ROOT, 'dataset/import_local_creation_from_inference.py'), ...(args.force ? ['--force'] : [])],
      { encoding: 'utf8', stdio: 'inherit' }
    );
    process.exit(proc.status ?? 1);
  }

  if (!OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY required (set in Experiments/benchmark/.env or n8n_json_schema/.env)'
    );
    process.exit(1);
  }
  if (!existsSync(manifestPath)) {
    console.error(`Missing ${manifestPath} — run: python3 dataset/prepare_creation_dataset.py --scale 300`);
    process.exit(1);
  }

  const manifest = loadManifest(manifestPath);
  const cases = filterCases(manifest, {
    limit: args.limit,
    offset: args.offset,
    caseId: args['case-id'],
  });

  const mode = String(args.mode || 'oneshot').trim().toLowerCase();
  const isStaged = mode === 'staged';

  let promptProfile = 's1';
  let resultsRoot;
  if (isStaged) {
    resultsRoot = resultsRootStaged(process.env.OPENAI_MODEL || STAGED_DEFAULT_MODEL);
  } else {
    try {
      promptProfile = resolvePromptProfile(args['prompt-profile']);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    resultsRoot = resultsRootForOneshot(BENCHMARK_ROOT, promptProfile, OPENAI_MODEL);
  }

  const oneshotMode = OPENAI_MODEL.startsWith('ft:') ? 'local_finetune' : 'local_gpt4o_oneshot';

  const modelLabel = isStaged
    ? process.env.OPENAI_MODEL || STAGED_DEFAULT_MODEL
    : OPENAI_MODEL;

  const withExecutability = Boolean(args['with-executability']);
  const repairOnExecute = Boolean(args['repair-on-execute']);

  console.log(
    `Local creation: ${cases.length} cases, mode=${mode}, model=${modelLabel}` +
      (isStaged ? '' : `, profile=${promptProfile}`) +
      (withExecutability ? `, executability=on${repairOnExecute ? '+repair' : ''}` : '')
  );
  console.log(`Results: ${resultsRoot}`);
  if (manifestPath.includes('300')) {
    console.log(`Manifest: ${manifestPath} (300-case)`);
  }

  const stats = { ok: 0, fail: 0, err: 0, skip: 0 };
  const costRows = [];
  for (const c of cases) {
    const res = isStaged
      ? await runOneCaseStaged(c, {
          force: !!args.force,
          dryRun: !!args['dry-run'],
          resultsRoot,
          withExecutability,
          repairOnExecute,
        })
      : await runOneCase(c, {
          force: !!args.force,
          dryRun: !!args['dry-run'],
          promptProfile,
          resultsRoot,
          oneshotMode,
          withExecutability,
          repairOnExecute,
        });
    if (res.skipped) stats.skip += 1;
    else if (res.error) stats.err += 1;
    else if (res.ok) stats.ok += 1;
    else if (res.ok === false) stats.fail += 1;
    if (isStaged && !args['dry-run']) {
      const metaPath = join(resultsRoot, c.id, 'meta.json');
      if (existsSync(metaPath)) {
        const meta = readJson(metaPath);
        if (meta.cost) costRows.push({ caseId: c.id, ...meta.cost });
      }
    }
    await sleep(Number(args.delay || 200));
  }
  console.log('Summary:', stats);
  if (isStaged && costRows.length) {
    const totals = mergeCostRows(costRows);
    const costSummaryPath = join(resultsRoot, 'staged_cost_summary.json');
    const payload = {
      generatedAt: new Date().toISOString(),
      model: modelLabel,
      mode: 'staged',
      perCase: costRows,
      totals,
    };
    writeJson(costSummaryPath, payload);
    console.log(
      `Cost: ${totals.total_tokens} tokens across ${totals.cases} cases, ` +
        `$${totals.total_usd.toFixed(4)} total → ${costSummaryPath}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
