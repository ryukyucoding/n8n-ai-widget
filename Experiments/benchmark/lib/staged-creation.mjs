/**
 * Staged creation via Python create_pipeline (plan → fill → validate).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(BENCHMARK_ROOT, '../..');
const STAGED_SCRIPT = join(BENCHMARK_ROOT, 'dataset/run_staged_creation.py');
const DEFAULT_VENV_PY = join(BENCHMARK_ROOT, '.venv/bin/python');
const PYTHON_BIN =
  process.env.PYTHON_BIN || (existsSync(DEFAULT_VENV_PY) ? DEFAULT_VENV_PY : 'python3');

import { modelSlugForResults } from './model-slug.mjs';

export const STAGED_DEFAULT_MODEL = process.env.STAGED_CREATE_MODEL || 'gpt-4.1';

export function resultsRootStaged(model = STAGED_DEFAULT_MODEL) {
  const slug = modelSlugForResults(model);
  const scaleSuffix = process.env.BENCHMARK_SCALE === '300' ? '-300' : '';
  return resolve(BENCHMARK_ROOT, `results/local/create-staged-${slug}${scaleSuffix}`);
}

export function readCaseInstruction(benchmarkRoot, caseEntry) {
  const p = resolve(benchmarkRoot, `data/creation/${caseEntry.id}/instruction.txt`);
  return readFileSync(p, 'utf8');
}

export function callStagedCreation({
  instruction,
  model = STAGED_DEFAULT_MODEL,
  apiKey = process.env.OPENAI_API_KEY || '',
  maxFixIterations = Number(process.env.STAGED_MAX_FIX_ITERATIONS || 2),
}) {
  const payload = {
    instruction,
    model,
    api_key: apiKey,
    max_fix_iterations: maxFixIterations,
  };
  const proc = spawnSync(PYTHON_BIN, [STAGED_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONPATH: [
        join(REPO_ROOT, 'chatbot/bundles/create'),
        join(REPO_ROOT, 'chatbot/bundles/modify'),
        process.env.PYTHONPATH || '',
      ]
        .filter(Boolean)
        .join(':'),
    },
  });
  if (proc.status !== 0) {
    return {
      ok: false,
      error: (proc.stderr || proc.stdout || 'staged creation failed').trim().slice(0, 2000),
    };
  }
  try {
    return JSON.parse(proc.stdout || '{}');
  } catch {
    return { ok: false, error: 'staged creation returned invalid JSON', raw: proc.stdout?.slice(0, 500) };
  }
}
