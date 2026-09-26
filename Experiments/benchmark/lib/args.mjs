import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when workflows should survive after a case (flag or BENCHMARK_KEEP_WORKFLOW env). */
export function resolveKeepWorkflow(args = {}) {
  if (args['keep-workflow']) return true;
  if (args['no-keep-workflow']) return false;
  const v = String(process.env.BENCHMARK_KEEP_WORKFLOW || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function loadManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function loadCredentialScan(scanPath) {
  const p = resolve(scanPath);
  if (!existsSync(p)) {
    throw new Error(`Credential scan not found: ${p} (run: python3 scan_insert_credentials.py)`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function caseIdsForCredentialTier(scan, tier) {
  const summary = scan.summary || {};
  const byTier = summary.tier_case_ids || {};
  if (tier === 'recommended') {
    return new Set(['A2', 'A', 'B', 'C'].flatMap((t) => byTier[t] || []));
  }
  return new Set(byTier[tier] || []);
}

export function filterCases(manifest, { operation, limit, offset, caseId, credentialTier, credentialScan }) {
  let cases = manifest.cases;
  if (operation && operation !== 'all') {
    if (operation === 'insert') {
      cases = cases.filter((c) => c.operation === 'insert' || String(c.operation || '').startsWith('insert-'));
    } else if (operation === 'delete' || operation === 'modify') {
      cases = cases.filter((c) => c.operation === operation);
    } else {
      cases = cases.filter((c) => c.operation === operation || c.id.startsWith(`${operation}-`));
    }
  }
  if (credentialTier) {
    const scan = loadCredentialScan(credentialScan || 'data/insert_credential_scan.json');
    const allowed = caseIdsForCredentialTier(scan, credentialTier);
    cases = cases.filter((c) => allowed.has(c.id));
  }
  if (caseId) {
    cases = cases.filter((c) => c.id === caseId);
  }
  const off = Number(offset || 0);
  const lim = limit != null ? Number(limit) : cases.length;
  return cases.slice(off, off + lim);
}
