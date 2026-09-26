#!/usr/bin/env node
/**
 * Measure import + execute (+ optional repair) for benchmark preds.
 *
 *   node scripts/measure_executability.mjs --results results/local/create-staged --limit 5
 *   node scripts/measure_executability.mjs --results results/local/create-gpt4o-semantic --repair --limit 10
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sleep } from '../lib/args.mjs';
import { measureExecutability, resolveN8nBaseUrl } from '../lib/n8n-executability.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(__dirname, '..');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function listCaseIds(resultsRoot, { offset, limit, caseId }) {
  if (caseId) return [caseId];
  const ids = readdirSync(resultsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^create-\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  return ids.slice(offset, limit ? offset + limit : undefined);
}

function readInstruction(caseId) {
  const p = join(BENCHMARK_ROOT, 'data/creation', caseId, 'instruction.txt');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function readValidationIssues(caseDir) {
  const traj = join(caseDir, 'trajectory.json');
  if (!existsSync(traj)) return null;
  try {
    const t = readJson(traj);
    return t.validation_issues || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsRoot = resolve(BENCHMARK_ROOT, args.results || 'results/local/create-staged');
  const offset = Number(args.offset || 0);
  const limit = args.limit ? Number(args.limit) : undefined;
  const repair = Boolean(args.repair);
  const force = Boolean(args.force);

  if (!existsSync(resultsRoot)) {
    throw new Error(`Results dir not found: ${resultsRoot}`);
  }

  const caseIds = listCaseIds(resultsRoot, {
    offset,
    limit,
    caseId: args['case-id'],
  });

  const baseUrl = resolveN8nBaseUrl();
  const rows = [];

  for (const cid of caseIds) {
    const caseDir = join(resultsRoot, cid);
    const predPath = join(caseDir, 'pred.json');
    const execPath = join(caseDir, 'executability.json');

    if (!existsSync(predPath)) {
      rows.push({ caseId: cid, missingPred: true });
      continue;
    }
    if (!force && existsSync(execPath)) {
      rows.push({ ...readJson(execPath), skipped: true });
      console.log(`[skip] ${cid} executability already measured`);
      continue;
    }

    const pred = readJson(predPath);
    const instruction = readInstruction(cid);
    const validationIssues = readValidationIssues(caseDir);

    console.log(`[exec] ${cid} repair=${repair}`);
    const row = await measureExecutability({
      workflow: pred,
      caseId: cid,
      baseUrl,
      repair,
      instruction,
      validationIssues,
    });
    writeFileSync(execPath, JSON.stringify(row, null, 2));
    rows.push(row);
    console.log(
      `  import=${row.import_ok} exec=${row.final_execute_status} ` +
        `repair_ok=${row.repair_success} (${row.elapsedMs}ms)`
    );
    await sleep(Number(args.delay || 500));
  }

  const measured = rows.filter((r) => !r.missingPred && !r.skipped);
  const summary = {
    generatedAt: new Date().toISOString(),
    resultsRoot,
    baseUrl,
    repair,
    totalCases: rows.length,
    measured: measured.length,
    importOk: measured.filter((r) => r.import_ok).length,
    executeSuccess: measured.filter((r) => r.final_execute_success).length,
    runtimeReached: measured.filter((r) => r.runtime_reached).length,
    credentialBlocked: measured.filter((r) => r.credential_blocked).length,
    repairEnabled: repair,
    repairFixed: measured.filter((r) => r.repair_success).length,
    rows,
  };

  const outPath = join(resultsRoot, 'executability_summary.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log('\n=== Executability summary ===');
  console.log(`import ok: ${summary.importOk}/${summary.measured}`);
  console.log(`execute success: ${summary.executeSuccess}/${summary.measured}`);
  console.log(`runtime reached (incl. fixable errors): ${summary.runtimeReached}/${summary.measured}`);
  console.log(`credential blocked: ${summary.credentialBlocked}/${summary.measured}`);
  if (repair) console.log(`repair fixed: ${summary.repairFixed}/${summary.measured}`);
  console.log(`report: ${outPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
