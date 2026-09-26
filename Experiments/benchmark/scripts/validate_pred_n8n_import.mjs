#!/usr/bin/env node
/**
 * Import pred.json workflows into n8n and report pass rates + failure modes.
 *
 *   node scripts/validate_pred_n8n_import.mjs [--results results/local/create] [--limit 30] [--offset 0]
 *   node scripts/validate_pred_n8n_import.mjs --dry-run   # skip live n8n POST/DELETE
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import {
  createWorkflow,
  deleteWorkflow,
  nodeNames,
  stripWorkflowForImport,
} from '../lib/n8n-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');

const TRIGGER_HINTS = [
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.cron',
  '@n8n/n8n-nodes-langchain.chatTrigger',
];

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function listCaseIds(resultsRoot, { offset, limit }) {
  const ids = readdirSync(resultsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^create-\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  return ids.slice(offset, limit ? offset + limit : undefined);
}

function connectionIssues(workflow) {
  const names = nodeNames(workflow);
  const conns = workflow.connections || {};
  let badSources = 0;
  let badTargets = 0;

  for (const [src, outputs] of Object.entries(conns)) {
    if (!names.has(src)) badSources += 1;
    if (!outputs || typeof outputs !== 'object') continue;
    for (const branches of Object.values(outputs)) {
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!Array.isArray(branch)) continue;
        for (const t of branch) {
          if (t?.node && !names.has(t.node)) badTargets += 1;
        }
      }
    }
  }

  return { badSources, badTargets };
}

function hasTrigger(workflow) {
  const nodes = workflow.nodes || [];
  return nodes.some((n) => {
    const type = n?.type || '';
    const name = (n?.name || '').toLowerCase();
    return TRIGGER_HINTS.includes(type) || type.includes('Trigger') || name.includes('trigger');
  });
}

function analyzePred(cid, pred, score, manifestGt) {
  const nodes = pred.nodes || [];
  const gt = manifestGt[cid] ?? null;
  const summary = score?.summary || {};
  const nodeF1 = summary.node_f1 ?? null;
  const connF1 = summary.matched_connection_f1 ?? null;
  const conn = connectionIssues(pred);

  const issues = [];
  if (!nodes.length) issues.push('no_nodes');
  if (!hasTrigger(pred)) issues.push('no_trigger');
  if (conn.badSources) issues.push(`connection_source_not_node_name(${conn.badSources})`);
  if (conn.badTargets) issues.push(`connection_target_missing(${conn.badTargets})`);
  if (gt && nodes.length > gt * 2.5) issues.push(`node_bloat(${nodes.length} vs gt ${gt})`);
  if (nodeF1 === 0) issues.push('node_f1_zero');
  if (gt && gt > 5 && (connF1 ?? 0) < 0.3) issues.push('disconnected_or_wrong_graph');

  const structOk =
    nodes.length > 0 &&
    hasTrigger(pred) &&
    !issues.some((i) => i.startsWith('connection_source_not_node_name')) &&
    !issues.some((i) => i.startsWith('node_bloat'));

  const qualityOk = (nodeF1 ?? 0) >= 0.5 && (connF1 ?? 0) >= 0.3;

  return {
    caseId: cid,
    predNodes: nodes.length,
    gtNodes: gt,
    nodeF1,
    matchedConnectionF1: connF1,
    connectionBadSources: conn.badSources,
    connectionBadTargets: conn.badTargets,
    issues,
    structOk,
    qualityOk,
  };
}

async function tryImport(baseUrl, apiKey, doc) {
  const wf = await createWorkflow(baseUrl, apiKey, doc);
  await deleteWorkflow(baseUrl, apiKey, wf.id);
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsRoot = resolve(BENCHMARK_ROOT, args.results || 'results/local/create');
  const offset = Number(args.offset || 0);
  const limit = args.limit ? Number(args.limit) : undefined;
  const dryRun = Boolean(args['dry-run']);

  const baseUrl = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
  const apiKey = process.env.N8N_API_KEY || '';
  if (!dryRun && !apiKey) {
    throw new Error('N8N_API_KEY missing (use --dry-run for offline checks only)');
  }

  const manifest = existsSync(join(BENCHMARK_ROOT, 'data/manifest_creation.json'))
    ? readJson(join(BENCHMARK_ROOT, 'data/manifest_creation.json'))
    : { cases: [] };
  const manifestGt = Object.fromEntries(
    manifest.cases.map((c) => [c.id, c.functional_node_count])
  );

  const caseIds = listCaseIds(resultsRoot, { offset, limit });
  const rows = [];

  for (const cid of caseIds) {
    const predPath = join(resultsRoot, cid, 'pred.json');
    if (!existsSync(predPath)) {
      rows.push({ caseId: cid, missingPred: true });
      continue;
    }

    const pred = readJson(predPath);
    const scorePath = join(resultsRoot, cid, 'score.json');
    const score = existsSync(scorePath) ? readJson(scorePath) : null;
    const analysis = analyzePred(cid, pred, score, manifestGt);

    const rawDoc = {
      name: `bench-${cid}-raw`,
      nodes: pred.nodes,
      connections: pred.connections || {},
      settings: pred.settings || { executionOrder: 'v1' },
    };
    const stripDoc = stripWorkflowForImport(pred, `bench-${cid}-strip`);

    if (!dryRun) {
      try {
        await tryImport(baseUrl, apiKey, rawDoc);
        analysis.rawImportOk = true;
      } catch (e) {
        analysis.rawImportOk = false;
        analysis.rawImportError = e.message.slice(0, 400);
      }

      try {
        await tryImport(baseUrl, apiKey, stripDoc);
        analysis.stripImportOk = true;
      } catch (e) {
        analysis.stripImportOk = false;
        analysis.stripImportError = e.message.slice(0, 400);
      }
    }

    rows.push(analysis);
  }

  const withPred = rows.filter((r) => !r.missingPred);
  const summary = {
    generatedAt: new Date().toISOString(),
    resultsRoot,
    dryRun,
    totalCases: rows.length,
    withPred: withPred.length,
    missingPred: rows.filter((r) => r.missingPred).map((r) => r.caseId),
    rawImportOk: withPred.filter((r) => r.rawImportOk).length,
    stripImportOk: withPred.filter((r) => r.stripImportOk).length,
    structOk: withPred.filter((r) => r.structOk).length,
    qualityOk: withPred.filter((r) => r.qualityOk).length,
    rows,
  };

  const outPath = join(resultsRoot, 'pred_n8n_import_report.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log(`pred.json cases: ${withPred.length}/${rows.length}`);
  if (!dryRun) {
    console.log(`n8n API import (raw pred): ${summary.rawImportOk}/${withPred.length}`);
    console.log(`n8n API import (strip/sanitize): ${summary.stripImportOk}/${withPred.length}`);
  }
  console.log(`struct ok: ${summary.structOk}/${withPred.length}`);
  console.log(`quality ok (node_f1>=0.5, conn_f1>=0.3): ${summary.qualityOk}/${withPred.length}`);
  console.log(`report: ${outPath}`);

  const failed = withPred.filter((r) => !r.qualityOk);
  if (failed.length) {
    console.log('\nNot quality-ok:');
    for (const r of failed) {
      console.log(
        `  ${r.caseId}: nodes ${r.predNodes}/${r.gtNodes ?? '?'}  node_f1=${r.nodeF1}  conn_f1=${r.matchedConnectionF1}  issues=${r.issues.join(', ')}`
      );
      if (r.rawImportError) console.log(`    raw import: ${r.rawImportError.slice(0, 160)}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
