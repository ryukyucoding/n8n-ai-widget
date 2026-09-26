/**
 * Spawn repair_runner for benchmark preds (execution / validation errors).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');
const REPAIR_SCRIPT = join(BENCHMARK_ROOT, 'dataset/run_repair_pred.py');
const DEFAULT_VENV_PY = join(BENCHMARK_ROOT, '.venv/bin/python');
const PYTHON_BIN =
  process.env.PYTHON_BIN || (existsSync(DEFAULT_VENV_PY) ? DEFAULT_VENV_PY : 'python3');

export function callRepairPred({
  workflow,
  errorContext = null,
  validationIssues = null,
  instruction = '',
  priorSignatures = [],
  iteration = 1,
  model = process.env.OPENAI_MODEL || 'gpt-4o',
  apiKey = process.env.OPENAI_API_KEY || '',
  skipLlm = false,
}) {
  const payload = {
    workflow,
    error_context: errorContext,
    validation_issues: validationIssues,
    instruction,
    prior_signatures: priorSignatures,
    iteration,
    model,
    api_key: apiKey,
    skip_llm: skipLlm,
  };
  const proc = spawnSync(PYTHON_BIN, [REPAIR_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONPATH: [
        join(BENCHMARK_ROOT, '../../chatbot/python'),
        join(BENCHMARK_ROOT, '../../chatbot/bundles/modify'),
        process.env.PYTHONPATH || '',
      ]
        .filter(Boolean)
        .join(':'),
    },
  });
  if (proc.status !== 0) {
    return {
      ok: false,
      error: (proc.stderr || proc.stdout || 'repair failed').trim().slice(0, 2000),
    };
  }
  try {
    return JSON.parse(proc.stdout || '{}');
  } catch {
    return { ok: false, error: 'repair returned invalid JSON', raw: proc.stdout?.slice(0, 500) };
  }
}
