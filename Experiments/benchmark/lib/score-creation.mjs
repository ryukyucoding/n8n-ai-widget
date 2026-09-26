/**
 * Shared creation scoring: normalize pred connections, then invoke score_creation.py.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remapWorkflowConnectionsToNodeNames } from './n8n-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');
const DEFAULT_VENV_PY = resolve(BENCHMARK_ROOT, '.venv/bin/python');

export function pythonBin() {
  return process.env.PYTHON_BIN || (existsSync(DEFAULT_VENV_PY) ? DEFAULT_VENV_PY : 'python3.12');
}

/** Rewrite connection keys/targets to node.name (id/slug → name). */
export function normalizePredWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return workflow;
  return remapWorkflowConnectionsToNodeNames(JSON.parse(JSON.stringify(workflow)));
}

/**
 * Load pred.json, normalize connections, optionally write back.
 * @returns {object} normalized workflow
 */
export function normalizePredFile(predPath, { writeBack = true } = {}) {
  const raw = JSON.parse(readFileSync(predPath, 'utf8'));
  const normalized = normalizePredWorkflow(raw);
  if (writeBack) {
    writeFileSync(predPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  }
  return normalized;
}

export function scoreCreation({
  goldPath,
  predPath,
  outScorePath,
  skipParam = false,
  normalize = true,
  benchmarkRoot = BENCHMARK_ROOT,
} = {}) {
  if (normalize && predPath && existsSync(predPath)) {
    normalizePredFile(predPath, { writeBack: true });
  }

  const args = [
    join(benchmarkRoot, 'score_creation.py'),
    '--gold',
    goldPath,
    '--pred',
    predPath,
    '--out',
    outScorePath,
  ];
  if (skipParam) args.push('--skip-parameter-eval');

  const proc = spawnSync(pythonBin(), args, { encoding: 'utf8' });
  let score = null;
  if (outScorePath && existsSync(outScorePath)) {
    try {
      score = JSON.parse(readFileSync(outScorePath, 'utf8'));
    } catch {
      score = null;
    }
  }
  return { ok: proc.status === 0, score, stderr: proc.stderr };
}
