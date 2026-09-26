#!/usr/bin/env node
/**
 * Import creation gold workflows as read-only reference templates in n8n.
 * Stores URLs in data/gold_template_refs.json for run-sheet cross-links.
 *
 *   node scripts/import_gold_template_refs.mjs local [--force]
 *   node scripts/import_gold_template_refs.mjs cloud [--force]
 *   node scripts/import_gold_template_refs.mjs all [--force]
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { stripWorkflowForImport, createWorkflow } from '../lib/n8n-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');
const MANIFEST_PATH = resolve(BENCHMARK_ROOT, 'data/manifest_creation.json');
const REFS_PATH = resolve(BENCHMARK_ROOT, 'data/gold_template_refs.json');

const TARGETS = {
  local: {
    baseUrl: (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, ''),
    apiKey: process.env.N8N_API_KEY || '',
    resultsRoot: resolve(BENCHMARK_ROOT, 'results/local/create-ref'),
  },
  cloud: {
    baseUrl: (process.env.N8N_CLOUD_URL || 'https://widmn8n.app.n8n.cloud').replace(/\/$/, ''),
    apiKey: process.env.N8N_CLOUD_API_KEY || '',
    resultsRoot: resolve(BENCHMARK_ROOT, 'results/cloud/create-ref'),
  },
};

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function importTarget(target, { force }) {
  const cfg = TARGETS[target];
  if (!cfg.apiKey) throw new Error(`${target}: API key missing`);

  const manifest = readJson(MANIFEST_PATH);
  const refs = existsSync(REFS_PATH) ? readJson(REFS_PATH) : { version: 1, local: {}, cloud: {} };
  refs[target] = refs[target] || {};

  for (const caseEntry of manifest.cases || []) {
    const caseId = caseEntry.id;
    const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);
    const outDir = join(cfg.resultsRoot, caseId);
    const metaPath = join(outDir, 'meta.json');
    mkdirSync(outDir, { recursive: true });

    let meta = existsSync(metaPath) ? readJson(metaPath) : {};
    if (meta.workflowUrl && !force) {
      refs[target][caseId] = {
        caseId,
        goldName: caseEntry.gold_name,
        goldPath: caseEntry.gold_path,
        complexity: caseEntry.complexity,
        functionalNodeCount: caseEntry.functional_node_count,
        workflowId: meta.workflowId,
        workflowUrl: meta.workflowUrl,
      };
      console.log(`[keep] ${target} ${caseId} → ${meta.workflowUrl}`);
      continue;
    }

    const gold = readJson(goldPath);
    const doc = stripWorkflowForImport(gold, `gold-ref-${caseId}`);
    const created = await createWorkflow(cfg.baseUrl, cfg.apiKey, doc);
    const workflowUrl = `${cfg.baseUrl}/workflow/${created.id}`;

    meta = {
      caseId,
      mode: `gold_template_ref_${target}`,
      preparedAt: new Date().toISOString(),
      workflowId: created.id,
      workflowUrl,
      goldPath: caseEntry.gold_path,
      goldName: caseEntry.gold_name,
    };
    writeJson(metaPath, meta);

    refs[target][caseId] = {
      caseId,
      goldName: caseEntry.gold_name,
      goldPath: caseEntry.gold_path,
      complexity: caseEntry.complexity,
      functionalNodeCount: caseEntry.functional_node_count,
      workflowId: created.id,
      workflowUrl,
    };
    console.log(`[import] ${target} ${caseId} → ${workflowUrl}`);
  }

  refs.updatedAt = new Date().toISOString();
  writeJson(REFS_PATH, refs);
  console.log(`\nWrote ${REFS_PATH} (${Object.keys(refs[target]).length} ${target} refs)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const targetArg = argv[0];
  const args = parseArgs(argv.slice(1));
  const targets =
    targetArg === 'all' ? ['local', 'cloud'] : targetArg === 'local' || targetArg === 'cloud' ? [targetArg] : null;

  if (!targets) {
    console.error('Usage: node scripts/import_gold_template_refs.mjs local|cloud|all [--force]');
    process.exit(1);
  }

  for (const target of targets) {
    try {
      await importTarget(target, { force: !!args.force });
    } catch (e) {
      console.error(`[error] ${target}: ${e.message}`);
      if (targetArg !== 'all') process.exit(1);
    }
  }
}

main();
