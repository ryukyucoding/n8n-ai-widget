'use strict';

// Gauge's E2E scoring entrypoint (route v3). Run by GAUGE only, in its own
// session, with its sealed file; Keystone never runs this on sealed data.
//   node score-e2e.js <plan.json> <sealed.json> <out.json> <expected sealed sha256>
// sealed.json: { "task": "<id>", "fixture": [ {...}, ... ],
//                "assertions": [ { "kind": "count_eq"|"field_set_eq"|"items_eq_ordered"|"items_eq_multiset", "role": "<role>", "value": ... } ] }
// A task passes only if: the validator is clean, every checkpoint contract
// holds, every bound role has a count_eq, every sealed assertion holds, no
// sink or non-allowlisted node executed and no credential was looked up.

const fs = require('node:fs');
const crypto = require('node:crypto');
const route = require('./route3');

const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const ms = (xs) => xs.map(canon).sort();

function scoreAssertion(a, items) {
  switch (a.kind) {
    case 'count_eq': return items.length === a.value;
    case 'field_set_eq': return items.every((it) => canon(Object.keys(it).sort()) === canon([...a.value].sort()));
    case 'items_eq_ordered': return canon(items) === canon(a.value);
    case 'items_eq_multiset': return canon(ms(items)) === canon(ms(a.value));
    default: return false; // unknown kinds fail closed
  }
}

async function scoreSealed(plan, sealed) {
  // The plan must be scored only against its own sealed task, and the sealed file must be well-formed.
  const binding = [];
  if (typeof plan?.task !== 'string' || !plan.task) binding.push('plan.task must be a non-empty string');
  if (typeof sealed?.task !== 'string' || !sealed.task) binding.push('sealed.task must be a non-empty string');
  if (!binding.length && plan.task !== sealed.task) binding.push('plan.task does not match sealed.task');
  // v3.8: EITHER fixture: [...] (one injection) OR fixtures: {"<pinKey>"|"@trigger": [...]} (labelled).
  const hasArr = sealed && Object.prototype.hasOwnProperty.call(sealed, 'fixture');
  const hasMap = sealed && Object.prototype.hasOwnProperty.call(sealed, 'fixtures');
  if (hasArr === hasMap) binding.push('sealed must carry exactly one of fixture | fixtures');
  else if (hasArr && (!Array.isArray(sealed.fixture) || !sealed.fixture.length)) binding.push('sealed.fixture must be a non-empty array');
  else if (hasMap && (!sealed.fixtures || typeof sealed.fixtures !== 'object' || Array.isArray(sealed.fixtures) || !Object.keys(sealed.fixtures).length
    || Object.values(sealed.fixtures).some((x) => !Array.isArray(x)) || Object.values(sealed.fixtures).every((x) => !x.length))) binding.push('sealed.fixtures must map labels to arrays (not all empty)');
  if (!binding.length && plan && Array.isArray(plan.checkpoints)) {
    const pp = route.pinPlan(plan, hasArr ? sealed.fixture : sealed.fixtures, 'Trigger');
    if (pp.error) binding.push(`fixture/plan pin mismatch: ${pp.error}`);
  }
  if (!Array.isArray(sealed?.assertions) || !sealed.assertions.length) binding.push('sealed.assertions must be a non-empty array');
  if (binding.length) return { task: sealed?.task, planTask: plan?.task, taskBindingFindings: binding, pass: false, refused: true };
  const workflow = route.assemble(plan);
  const findings = route.validate(workflow, plan);
  const roles = Object.keys(plan.outputBindings || {});
  const missingCount = roles.filter((r) => !sealed.assertions.some((a) => a.role === r && a.kind === 'count_eq'));
  const result = { task: sealed.task, validatorFindings: findings, rolesWithoutCount: missingCount };
  if (findings.length || missingCount.length) return { ...result, pass: false, refused: true };
  const ex = await route.execute(workflow, plan, Object.prototype.hasOwnProperty.call(sealed, 'fixtures') ? sealed.fixtures : sealed.fixture);
  // A role whose binding did not resolve to a produced port fails; it is never scored as [].
  const assertions = sealed.assertions.map((a) => ({ kind: a.kind, role: a.role, pass: roles.includes(a.role) && Object.prototype.hasOwnProperty.call(ex.roleItems, a.role) && Array.isArray(ex.roleItems[a.role]) && scoreAssertion(a, ex.roleItems[a.role]) }));
  const pass = ex.bindingErrors.length === 0 && ex.contracts.every((c) => c.pass) && assertions.every((a) => a.pass) && ex.executedSinks === 0 && ex.unsafeExecuted === 0 && ex.credentialLookups === 0;
  // Only pass/fail and structural errors are reported; item values are not echoed.
  return { ...result, pass, contracts: ex.contracts, bindingErrors: ex.bindingErrors, assertions, executedSinks: ex.executedSinks, unsafeExecuted: ex.unsafeExecuted, credentialLookups: ex.credentialLookups };
}

// CLI: the sealed file's raw bytes must match the sha256 Gauge published in its
// manifest, and both hashes are recorded in out.json, so every score is bound
// to an exact plan and an exact sealed file.
// ACCEPTANCE BOUNDARY: one call binds ONE sealed file. It does not prove that
// every fixture of a task (e.g. both F0 and F1) was scored; whoever accepts a
// task must check that out.json files exist for every manifest hash of it.
async function cli([planPath, sealedPath, outPath, expectedSealedSha256]) {
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  if (!planPath || !sealedPath || !outPath || !/^[0-9a-f]{64}$/.test(expectedSealedSha256 || '')) {
    throw new Error('usage: node score-e2e.js <plan.json> <sealed.json> <out.json> <expected sealed sha256 from Gauge manifest>');
  }
  // out.json must be a NEW file: it can never alias (path, symlink or hardlink) an input.
  if (fs.existsSync(outPath)) throw new Error('usage: <out.json> must not already exist (refusing to overwrite; it may alias an input)');
  const planBytes = fs.readFileSync(planPath);
  const sealedBytes = fs.readFileSync(sealedPath);
  const hashes = { planSha256: sha(planBytes), sealedSha256: sha(sealedBytes), expectedSealedSha256 };
  const r = hashes.sealedSha256 !== expectedSealedSha256
    ? { pass: false, refused: true, manifestFindings: ['sealed file sha256 does not match the expected manifest hash'] }
    : await scoreSealed(JSON.parse(planBytes.toString('utf8')), JSON.parse(sealedBytes.toString('utf8')));
  const out = { ...r, ...hashes };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), { flag: 'wx' });
  return out;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then((r) => {
    process.stdout.write(`E2E_SCORE ${JSON.stringify({ task: r.task, pass: r.pass, refused: Boolean(r.refused), sealedSha256: r.sealedSha256 })}\n`);
    process.exit(0);
  }, (e) => {
    // Messages can quote sealed values (engine or JSON errors), so only usage errors are shown.
    console.error('E2E SCORE FAILED:', e.message.startsWith('usage:') ? e.message : `${e.name} (message withheld)`);
    process.exit(1);
  });
}

module.exports = { scoreSealed, cli };
