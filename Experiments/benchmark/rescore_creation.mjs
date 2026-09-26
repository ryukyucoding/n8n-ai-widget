#!/usr/bin/env node
/**
 * Remap connection keys (id/slug → node.name) and re-score existing creation preds.
 *
 *   node rescore_creation.mjs [--results-dir results/local/create] [--force]
 *   node rescore_creation.mjs --case-id create-002 --force
 */

import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadManifest, filterCases } from './lib/args.mjs';
import { normalizePredFile, scoreCreation } from './lib/score-creation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;
const MANIFEST_PATH = resolve(BENCHMARK_ROOT, 'data/manifest_creation.json');
const DEFAULT_RESULTS = resolve(BENCHMARK_ROOT, 'results/local/create');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function discoverCaseDirs(resultsRoot, manifestCases, caseId) {
  if (caseId) {
    const d = join(resultsRoot, caseId);
    return existsSync(join(d, 'pred.json')) ? [caseId] : [];
  }
  if (manifestCases?.length) {
    return manifestCases
      .map((c) => c.id)
      .filter((id) => existsSync(join(resultsRoot, id, 'pred.json')));
  }
  if (!existsSync(resultsRoot)) return [];
  return readdirSync(resultsRoot)
    .filter((name) => statSync(join(resultsRoot, name)).isDirectory())
    .filter((name) => existsSync(join(resultsRoot, name, 'pred.json')))
    .sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsRoot = resolve(BENCHMARK_ROOT, args['results-dir'] || DEFAULT_RESULTS);
  const force = !!args.force;
  const skipParam = !!args['skip-parameter-eval'];

  let manifestCases = [];
  if (existsSync(MANIFEST_PATH)) {
    const manifest = loadManifest(MANIFEST_PATH);
    manifestCases = filterCases(manifest, {
      limit: args.limit,
      offset: args.offset,
      caseId: args['case-id'],
    });
  }

  const caseIds = discoverCaseDirs(resultsRoot, manifestCases, args['case-id']);
  if (!caseIds.length) {
    console.error(`No pred.json under ${resultsRoot}`);
    process.exit(1);
  }

  console.log(`Rescore: ${caseIds.length} cases in ${resultsRoot}`);

  const stats = { ok: 0, fail: 0, skip: 0 };
  for (const caseId of caseIds) {
    const outDir = join(resultsRoot, caseId);
    const predPath = join(outDir, 'pred.json');
    const scorePath = join(outDir, 'score.json');
    const metaPath = join(outDir, 'meta.json');

    if (!force && existsSync(scorePath)) {
      const meta = existsSync(metaPath) ? readJson(metaPath) : {};
      if (meta.connectionsRemappedAt) {
        console.log(`[skip] ${caseId} already remapped+scored`);
        stats.skip += 1;
        continue;
      }
    }

    const goldRel =
      manifestCases.find((c) => c.id === caseId)?.gold_path ||
      `data/creation/${caseId}/gold.json`;
    const goldPath = resolve(BENCHMARK_ROOT, goldRel);
    if (!existsSync(goldPath)) {
      console.error(`[error] ${caseId}: missing gold ${goldPath}`);
      stats.fail += 1;
      continue;
    }

    normalizePredFile(predPath, { writeBack: true });
    const { ok, score, stderr } = scoreCreation({
      goldPath,
      predPath,
      outScorePath: scorePath,
      skipParam,
      normalize: false,
    });

    const meta = existsSync(metaPath) ? readJson(metaPath) : { caseId, operation: 'create' };
    meta.connectionsRemappedAt = new Date().toISOString();
    meta.rescoredAt = meta.connectionsRemappedAt;
    writeJson(metaPath, meta);

    const s = score?.summary || {};
    console.log(
      `[${ok ? 'OK' : 'FAIL'}] ${caseId}  ` +
        `node_f1=${s.node_f1 ?? '?'} conn_f1=${s.connection_f1 ?? '?'} ` +
        `matched_conn_f1=${s.matched_connection_f1 ?? '?'} param=${s.parameter_accuracy ?? '?'}`
    );
    if (stderr?.trim()) console.error(stderr.trim().slice(0, 200));
    if (ok) stats.ok += 1;
    else stats.fail += 1;
  }

  console.log('Summary:', stats);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
