'use strict';

// Route v3 (E2E mode) controls on SYNTHETIC plans and SYNTHETIC sealed files
// authored here for testing only (never Gauge's sealed material), plus a check
// that the frozen v1/v2 route files are unchanged.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const route = require('../src/directRoute/route3');
const test = require('node:test');
const assert = require('node:assert');
const { scoreSealed } = require('../src/directRoute/score-e2e');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../src/directRoute', f))).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

const plan = {
  task: 'ctl-e2e', settings: { executionOrder: 'v1' }, input: { kind: 'trigger_items' },
  checkpoints: [
    { id: 'CP1', dependsOn: { node: '@trigger', port: 0 },
      node: { name: 'CP1 Keep Paid', type: 'n8n-nodes-base.filter', typeVersion: 2.3, parameters: {
        conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [{ id: 'c', leftValue: '={{ $json.status }}', rightValue: 'paid', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
        options: { ignoreCase: false } } },
      contract: { cardinality: 'items', fields: { id: 'string', status: 'string', amount: 'number' } } },
    { id: 'CP2', dependsOn: { node: 'CP1 Keep Paid', port: 0 },
      node: { name: 'CP2 Total', type: 'n8n-nodes-base.summarize', typeVersion: 1.1, parameters: { fieldsToSummarize: { values: [{ aggregation: 'sum', field: 'amount' }] }, options: {} } },
      contract: { cardinality: 'one', fields: { sum_amount: 'number' } } },
  ],
  outputBindings: { total: { node: 'CP2 Total', port: 0 } },
};
const sealed = {
  task: 'ctl-e2e',
  fixture: [{ id: 'a', status: 'paid', amount: 10 }, { id: 'b', status: 'open', amount: 5 }, { id: 'c', status: 'paid', amount: 7 }],
  assertions: [{ kind: 'count_eq', role: 'total', value: 1 }, { kind: 'items_eq_ordered', role: 'total', value: [{ sum_amount: 17 }] }],
};

// SYNTHETIC shape registry for controls only (the real one comes from Forge's audited cards).
const SYNTH_SHAPES = { shapes: [{ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, resource: 'sheet', operation: 'read', fields: { row_number: 'number' }, extra: 'sheet-columns', citations: ['SYNTHETIC/controls-only.js:1'] }] };

test('V3 Controls Suite (147/147)', async (t) => {
  route.setShapeRegistry(SYNTH_SHAPES);
  const results = [];
  const add = (label, pass, why) => results.push({ label, pass, why });

  add('frozen v1 route.js unchanged', sha('route.js').startsWith('45dfc727'));
  add('frozen v2 route2.js unchanged', sha('route2.js').startsWith('28a1279c'));

  const ok = await scoreSealed(plan, sealed);
  add('positive: contracts + sealed assertions pass', ok.pass === true, ok);

  let p = clone(plan); delete p.checkpoints[1].contract;
  add('missing contract rejected', route.validate(route.assemble(p), p).some((f) => f.includes('requires a structural contract')));

  p = clone(plan); p.checkpoints[0].contract.fields.amount = 'money';
  add('unsupported contract type rejected', route.validate(route.assemble(p), p).some((f) => f.includes('unsupported type')));

  let s = clone(sealed); s.assertions = s.assertions.filter((a) => a.kind !== 'count_eq');
  let r = await scoreSealed(plan, s);
  add('sealed role without count_eq: scoring refuses', r.refused === true && r.pass === false, r);

  p = clone(plan); p.checkpoints[1].contract.fields = { total: 'number' };
  r = await scoreSealed(p, sealed);
  add('contract field mismatch detected (sum_amount vs total)', r.pass === false && r.contracts.some((c) => !c.pass), r.contracts);

  s = clone(sealed); s.assertions[1].value = [{ sum_amount: 99 }];
  r = await scoreSealed(plan, s);
  add('wrong sealed value detected', r.pass === false && r.assertions.some((a) => !a.pass), r.assertions);

  s = clone(sealed); s.assertions.push({ kind: 'mystery_kind', role: 'total', value: 1 });
  r = await scoreSealed(plan, s);
  add('unknown sealed assertion kind fails closed', r.pass === false, r.assertions);

  s = clone(sealed); s.fixture = s.fixture.map((x) => ({ ...x, amount: String(x.amount) }));
  r = await scoreSealed(plan, s);
  add('type drift in data (amount as string) fails', r.pass === false, r.contracts);

  p = clone(plan); p.checkpoints[0].node.typeVersion = 99;
  r = await scoreSealed(p, sealed);
  add('v2 rules still apply in E2E mode (unknown version refused)', r.refused === true, r.validatorFindings);

  // --- Operator audit @ c881cbd regressions (validate only; unsafe nodes are never executed) ---
  const PHRASE = 'execution assertions (with count) are required';
  const inject = (node) => { const q = clone(plan); q.checkpoints.push({ id: 'CP3', dependsOn: { node: 'CP2 Total', port: 0 }, node, contract: { cardinality: 'one', fields: { x: 'string' } } }); return q; };
  p = inject({ name: PHRASE, type: 'n8n-nodes-base.executeCommand', typeVersion: 1, parameters: { command: 'echo hi' } });
  let f = route.validate(route.assemble(p), p);
  add('OP-1a: node named with the count phrase cannot hide a denied executeCommand', f.some((x) => x.includes('denied')), f);
  p = inject({ name: `CP3: ${PHRASE}`, type: 'n8n-nodes-base.filter', typeVersion: 99, parameters: {} });
  f = route.validate(route.assemble(p), p);
  add('OP-1b: node named like the exact finding cannot hide an unknown version', f.length > 0, f);
  r = await scoreSealed(p, sealed);
  add('OP-1c: scoring refuses the crafted plan', r.refused === true && r.pass === false, r.validatorFindings);

  p = clone(plan); p.outputBindings = { total: { node: 'CP1 Keep Paid', port: 9 } };
  s = clone(sealed); s.fixture = [{ id: 'a', status: 'paid', amount: 1 }]; s.assertions = [{ kind: 'count_eq', role: 'total', value: 0 }];
  r = await scoreSealed(p, s);
  add('OP-2a: nonexistent output port 9 cannot yield count_eq:0 pass (refused statically)', r.pass === false && r.refused === true && r.validatorFindings.some((x) => x.includes('port 9 does not exist')), r);
  { const ex = await route.execute(route.assemble(p), p, s.fixture); add('OP-2a-rt: runtime guard still errors on port 9 (validate skipped)', ex.bindingErrors.length === 1, ex.bindingErrors); }
  p = clone(plan); p.checkpoints[0].contract.port = 9;
  r = await scoreSealed(p, sealed);
  add('OP-2b: contract on nonexistent port fails (refused statically)', r.pass === false && r.refused === true && r.validatorFindings.some((x) => x.includes('contract port 9 does not exist')), r.validatorFindings);
  { const ex = await route.execute(route.assemble(p), p, sealed.fixture); add('OP-2b-rt: runtime guard still fails the contract (validate skipped)', ex.contracts.some((c) => !c.pass), ex.contracts); }
  for (const bad of [{ node: 'CP1 Keep Paid', port: -1 }, { node: 'CP1 Keep Paid', port: '0' }, { node: 'Trigger', port: 0 }, { node: 'CP1 Keep Paid' }]) {
    p = clone(plan); p.outputBindings = { total: bad };
    f = route.validate(route.assemble(p), p);
    add(`OP-2c: malformed binding refused ${JSON.stringify(bad)}`, f.some((x) => x.startsWith('outputBindings.total')), f);
  }
  p = clone(plan); p.outputBindings = {};
  add('OP-2d: empty outputBindings refused', route.validate(route.assemble(p), p).some((x) => x.startsWith('outputBindings')));

  // --- Optional-field form ("|absent"), for Gauge's E2E-3 note (a) ---
  const opt = clone(plan); opt.checkpoints[0].contract.fields.comment = 'string|absent';
  const optSealed = clone(sealed); optSealed.fixture[0].comment = 'late';
  r = await scoreSealed(opt, optSealed);
  add('ABS-1: optional field may be present or absent', r.pass === true, r);
  s = clone(sealed); s.fixture[0].comment = 'late';
  r = await scoreSealed(plan, s);
  add('ABS-2: undeclared field still fails', r.pass === false && r.contracts[0].pass === false, r.contracts);
  s = clone(sealed); delete s.fixture[0].amount;
  r = await scoreSealed(plan, s);
  add('ABS-3: missing required field still fails', r.pass === false && r.contracts[0].pass === false, r.contracts);
  p = clone(plan); p.checkpoints[0].contract.fields.comment = 'absent';
  add('ABS-4: bare "absent" type refused', route.validate(route.assemble(p), p).some((x) => x.includes('unsupported type')));
  s = clone(optSealed); s.fixture[0].comment = 5;
  r = await scoreSealed(opt, s);
  add('ABS-5: present optional field is still type-checked', r.pass === false, r.contracts);

  // --- Operator re-audit @ 7dc97fe: prototype-named keys are never "declared" ---
  for (const k of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    const errs = route.checkContract([JSON.parse(`{"id":"x",${JSON.stringify(k)}:"undeclared"}`)], { cardinality: 'items', fields: { id: 'string' } });
    add(`PROTO-1: undeclared own field ${k} fails`, errs.length === 1 && errs[0].includes('undeclared'), errs);
  }
  const errsMissing = route.checkContract([{ id: 'x' }], { cardinality: 'items', fields: JSON.parse('{"id":"string","toString":"string"}') });
  add('PROTO-2: declared field toString missing from item fails (not satisfied by prototype)', errsMissing.length === 1 && errsMissing[0].includes('missing'), errsMissing);
  s = clone(sealed); s.assertions.push({ kind: 'count_eq', role: 'toString', value: 0 });
  r = await scoreSealed(plan, s);
  add('PROTO-3: sealed assertion on prototype-named unbound role fails', r.pass === false, r.assertions);

  // --- Operator re-audit @ db6eeb1: a plan is scored only against its own sealed task ---
  s = clone(sealed); s.task = 'ctl-other';
  r = await scoreSealed(plan, s);
  add('TASK-1: cross-task scoring refused before execution', r.refused === true && r.pass === false && r.taskBindingFindings.some((x) => x.includes('does not match')) && !r.contracts, r);
  for (const [label, mut] of [['plan.task missing', (q, t) => { delete q.task; }], ['sealed.task missing', (q, t) => { delete t.task; }],
    ['plan.task non-string', (q, t) => { q.task = 1; t.task = 1; }], ['empty fixture', (q, t) => { t.fixture = []; }], ['assertions not array', (q, t) => { t.assertions = {}; }]]) {
    p = clone(plan); s = clone(sealed); mut(p, s);
    r = await scoreSealed(p, s);
    add(`TASK-2: refused when ${label}`, r.refused === true && r.pass === false && r.taskBindingFindings.length > 0, r);
  }

  // --- Operator full sweep @ d3b1a9c (1): zero-network allowlist, whatever the plan declares ---
  const http = { name: 'CP3 Post', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, parameters: { method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', options: {} } };
  p = inject(clone(http));
  f = route.validate(route.assemble(p), p);
  add('SAFE-1: undeclared httpRequest POST refused by validate (never executed)', f.some((x) => x.includes('not offline-safe')), f);
  let threw = null;
  try { await route.execute(route.assemble(p), p, sealed.fixture); } catch (e) { threw = e.message; }
  add('SAFE-2: execute() itself refuses before running when validate is skipped', /refused/.test(threw || ''), threw);
  r = await scoreSealed(p, sealed);
  add('SAFE-3: scoring refuses the undeclared-sink plan', r.refused === true && r.pass === false, r.validatorFindings);
  p = inject({ name: 'CP3 Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return $input.all();' } });
  f = route.validate(route.assemble(p), p);
  add('SAFE-4: Code node refused in E2E mode (vm is not an isolation boundary)', f.some((x) => x.includes('not offline-safe')), f);
  p = inject({ ...clone(http), sideEffect: true });
  f = route.validate(route.assemble(p), p);
  add('SAFE-5 (v3.8): a declared sink with no render rule (httpRequest) fails closed', f.some((x) => x.includes('no render rule')), f);

  // --- (2): sealed values never reach the report ---
  const CANARY = 'SYNTHETIC_CANARY_DO_NOT_EXPORT';
  s = clone(sealed); s.fixture[0][CANARY] = CANARY;
  r = await scoreSealed(plan, s);
  add('LEAK-1: undeclared data field name/value not echoed', r.pass === false && !JSON.stringify(r).includes(CANARY), r.contracts);
  p = clone(plan); p.checkpoints.splice(1, 0, { id: 'CPX', dependsOn: { node: 'CP1 Keep Paid', port: 0 },
    node: { name: 'CPX Throw', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { mode: 'manual', includeOtherFields: false, options: {},
      assignments: { assignments: [{ id: 'a', name: 'x', type: 'number', value: '={{ $json.secret }}' }] } } },
    contract: { cardinality: 'items', fields: { x: 'number' } } });
  p.checkpoints[2].dependsOn = { node: 'CPX Throw', port: 0 };
  s = clone(sealed); s.fixture = s.fixture.map((x) => ({ ...x, secret: CANARY }));
  r = await scoreSealed(p, s);
  add('LEAK-2: engine error quoting a fixture value is withheld', r.pass === false && !JSON.stringify(r).includes(CANARY) && r.contracts.some((c) => c.errors.some((e) => e.includes('withheld'))), r.contracts || r.validatorFindings);

  // --- (3): CLI binds the score to Gauge's manifest hash of the sealed file ---
  const { cli } = require('../src/directRoute/score-e2e');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'v3c-'));
  const w = (n, v) => { const fp = path.join(tmp, n); fs.writeFileSync(fp, JSON.stringify(v)); return fp; };
  const planFp = w('plan.json', plan); const sealedFp = w('sealed.json', sealed); const outFp = path.join(tmp, 'out.json');
  const goodSha = crypto.createHash('sha256').update(fs.readFileSync(sealedFp)).digest('hex');
  const fresh = () => { fs.rmSync(outFp, { force: true }); return outFp; };
  let o = await cli([planFp, sealedFp, fresh(), 'f'.repeat(64)]);
  add('MAN-1: sealed hash mismatch refused before scoring', o.refused === true && o.pass === false && o.manifestFindings && !o.contracts, o);
  threw = null; try { await cli([planFp, sealedFp, fresh()]); } catch (e) { threw = e.message; }
  add('MAN-2: missing expected hash is a usage error', /^usage:/.test(threw || ''), threw);
  o = await cli([planFp, sealedFp, fresh(), goodSha]);
  const written = JSON.parse(fs.readFileSync(outFp, 'utf8'));
  add('MAN-3: matching hash scores and records plan+sealed sha256', o.pass === true && written.sealedSha256 === goodSha && /^[0-9a-f]{64}$/.test(written.planSha256), written);
  // --- Operator re-audit @ ded1c73: out.json can never overwrite an input ---
  const before = { plan: fs.readFileSync(planFp, 'utf8'), sealed: fs.readFileSync(sealedFp, 'utf8') };
  const aliases = [['sealed path', sealedFp], ['plan path', planFp], ['relative alias of sealed', path.relative(process.cwd(), sealedFp)]];
  try { const hl = path.join(tmp, 'hardlink.json'); fs.linkSync(sealedFp, hl); aliases.push(['hardlink to sealed', hl]); } catch { /* hardlinks unsupported here */ }
  try { const sl = path.join(tmp, 'symlink.json'); fs.symlinkSync(sealedFp, sl); aliases.push(['symlink to sealed', sl]); } catch { /* symlinks need privilege on Windows */ }
  for (const [label, target] of aliases) {
    for (const hash of ['f'.repeat(64), goodSha]) {
      threw = null; try { await cli([planFp, sealedFp, target, hash]); } catch (e) { threw = e.message; }
      const intact = fs.readFileSync(planFp, 'utf8') === before.plan && fs.readFileSync(sealedFp, 'utf8') === before.sealed;
      add(`CLOB-1: out = ${label} (${hash === goodSha ? 'matching' : 'mismatched'} hash) refused, inputs intact`, /must not already exist/.test(threw || '') && intact, threw);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // --- CRED-PIN-F1 (closes X2-F1): never-run node configuration is checked statically ---
  const PLANS = path.resolve(__dirname, 'fixtures/plans');
  const loadPlan = (id) => JSON.parse(fs.readFileSync(path.join(PLANS, `${id}.plan.json`), 'utf8'));
  const nr = (q) => route.neverRunConfigFindings(route.assemble(q), q);
  const d09 = loadPlan('D09');
  add('PIN-1: D09 as published (documentId declared user setup) has no never-run finding', nr(d09).length === 0, nr(d09));
  p = clone(d09); Object.assign(p.checkpoints[0].node, { type: 'n8n-nodes-base.removeDuplicates', typeVersion: 2, parameters: { operation: 'removeDuplicateInputItems', compare: 'selectedFields', fieldsToCompare: '' } });
  add('PIN-2: the X2 control (empty dedupe field on the pin target) is now caught', nr(p).some((x) => x.includes('fieldsToCompare')), nr(p));
  p.checkpoints[0].node.parameters.fieldsToCompare = 'email';
  add('PIN-3: the same node with the field filled is clean', nr(p).length === 0, nr(p));
  p = clone(d09); p.requiredUserSetup = [];
  add('PIN-4: D09 empty documentId caught when not declared as user setup', nr(p).some((x) => x.includes('documentId')), nr(p));
  const d10 = loadPlan('D10');
  add('PIN-5: D10 as published (sink channelId declared user setup) is clean', nr(d10).length === 0, nr(d10));
  p = clone(d10); p.requiredUserSetup = [];
  add('PIN-6: D10 declared sink with empty channelId caught when undeclared', nr(p).some((x) => x.includes('channelId')), nr(p));
  for (const id of ['E1', 'E2', 'E3']) {
    const e = loadPlan(id);
    const fe = route.validate(route.assemble(e), e);
    add(`PIN-7: Demo 2 plan ${id} still validates clean`, fe.length === 0, fe);
  }

  // --- v3.7 (Demo 3 readiness): branches, merge, empty branches, pinned source + sink render roles ---
  const ifParams = { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'c', leftValue: '={{ $json.status }}', rightValue: 'paid', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} };
  const tag = (v) => ({ assignments: { assignments: [{ id: 't', name: 'tag', type: 'string', value: v }] }, includeOtherFields: true, options: {} });
  const row = { id: 'string', status: 'string', amount: 'number' };
  const branch = {
    task: 'ctl-branch', settings: { executionOrder: 'v1' }, input: { kind: 'trigger_items' },
    checkpoints: [
      { id: 'B1', dependsOn: { node: '@trigger', port: 0 }, node: { name: 'B1 Is Paid', type: 'n8n-nodes-base.if', typeVersion: 2.2, parameters: ifParams },
        contract: [{ port: 0, cardinality: 'items', fields: row }, { port: 1, cardinality: 'items', fields: row }] },
      { id: 'B2', dependsOn: { node: 'B1 Is Paid', port: 0 }, node: { name: 'B2 Tag Paid', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: tag('paid') }, contract: { cardinality: 'items', fields: { ...row, tag: 'string' } } },
      { id: 'B3', dependsOn: { node: 'B1 Is Paid', port: 1 }, node: { name: 'B3 Tag Open', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: tag('open') }, contract: { cardinality: 'items', fields: { ...row, tag: 'string' } } },
      { id: 'B4', dependsOn: [{ node: 'B2 Tag Paid', port: 0, inputIndex: 0 }, { node: 'B3 Tag Open', port: 0, inputIndex: 1 }], node: { name: 'B4 Merge', type: 'n8n-nodes-base.merge', typeVersion: 3.2, parameters: {} }, contract: { cardinality: 'items', fields: { ...row, tag: 'string' } } },
    ],
    outputBindings: { all: { node: 'B4 Merge', port: 0 }, open: { node: 'B3 Tag Open', port: 0 } },
  };
  const bSealed = (fixture, allN, openItems) => ({ task: 'ctl-branch', fixture, assertions: [{ kind: 'count_eq', role: 'all', value: allN }, { kind: 'count_eq', role: 'open', value: openItems.length }, { kind: 'items_eq_ordered', role: 'open', value: openItems }] });
  f = route.validate(route.assemble(branch), branch);
  add('BR-0: branch+merge plan (multi-dep, per-port contracts) validates clean', f.length === 0, f);
  r = await scoreSealed(branch, bSealed(sealed.fixture, 3, [{ id: 'b', status: 'open', amount: 5, tag: 'open' }]));
  add('BR-1: mixed data: both branches, merge of 3, per-port contracts hold', r.pass === true && r.contracts.length === 5, r);
  const allPaid = [{ id: 'a', status: 'paid', amount: 1 }];
  r = await scoreSealed(branch, bSealed(allPaid, 1, []));
  add('BR-2: empty branch: un-executed B3 reads as [] (legit empty), merge still 1, pass', r.pass === true && r.contracts.some((c) => c.id === 'B3' && c.emptyBranch), r);
  p = clone(branch); p.outputBindings.open = { node: 'B3 Tag Open', port: 1 };
  r = await scoreSealed(p, bSealed(allPaid, 1, []));
  add('BR-3: binding port 1 of single-output B3 refused statically', r.pass === false && r.refused === true, r.validatorFindings);
  { const ex = await route.execute(route.assemble(p), p, allPaid); add('BR-3-rt: un-executed node read on port 1 stays an error at runtime', ex.bindingErrors.length === 1, ex.bindingErrors); }
  p = clone(branch); p.checkpoints[2].dependsOn = { node: 'B1 Is Paid', port: 7 };
  f = route.validate(route.assemble(p), p);
  add('BR-4a: dependency on a port beyond the source arity (if has 2) refused by validate', f.some((x) => x.includes('port 7 does not exist')), f);
  const ex4 = await route.execute(route.assemble(p), p, sealed.fixture);
  add('BR-4b: ...and at runtime it is not "legit empty" either (validate skipped)', ex4.contracts.some((c) => c.id === 'B3' && !c.pass), ex4.contracts);

  // --- Operator @ 766c207 (B): nested empty chain must not hide a nonexistent port ---
  const nested = clone(branch); nested.checkpoints = nested.checkpoints.slice(0, 3);
  nested.checkpoints.push({ id: 'B5', dependsOn: { node: 'B3 Tag Open', port: 1 }, node: { name: 'B5 After Open', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: tag('x') }, contract: { cardinality: 'items', fields: { ...row, tag: 'string' } } });
  nested.outputBindings = { after: { node: 'B5 After Open', port: 0 } };
  f = route.validate(route.assemble(nested), nested);
  add('EMP-1: port 1 of a single-output Set (B3) refused by validate', f.some((x) => x.includes('port 1 does not exist')), f);
  const exN = await route.execute(route.assemble(nested), nested, allPaid);
  add('EMP-2: runtime: un-executed B3 port 1 does not make B5 "legit empty" (validate skipped)', exN.contracts.some((c) => c.id === 'B5' && !c.pass) && exN.bindingErrors.length === 1, { c: exN.contracts, b: exN.bindingErrors });
  const okNested = clone(nested); okNested.checkpoints[3].dependsOn = { node: 'B3 Tag Open', port: 0 };
  r = await scoreSealed(okNested, { task: 'ctl-branch', fixture: allPaid, assertions: [{ kind: 'count_eq', role: 'after', value: 0 }] });
  add('EMP-3: the correct nested empty chain (port 0) is still legit empty and passes', r.pass === true, r);

  // --- Operator @ 766c207 (A): checkpoint ids are unique identities ---
  p = clone(d10); const dupSink = clone(p.checkpoints.find((c) => c.id === 'CP3')); dupSink.node.name = 'CP3 Clone Sink';
  p.checkpoints.push(dupSink);
  add('DUP-1: duplicate checkpoint id refused (cloned D10 sink reusing CP3 and its setup)', nr(p).some((x) => x.includes('duplicate checkpoint id')), nr(p));
  p = clone(plan); p.checkpoints[1].id = '';
  f = route.validate(route.assemble(p), p);
  add('DUP-2: empty checkpoint id refused', f.some((x) => x.includes('checkpoint id must be')), f);
  for (const [label, mut, expect] of [
    ['dependsOn a LATER node', (q) => { q.checkpoints[1].dependsOn = { node: 'B4 Merge', port: 0 }; }, 'EARLIER'],
    ['merge with one input', (q) => { q.checkpoints[3].dependsOn = [q.checkpoints[3].dependsOn[0]]; }, 'one dependency per input'],
    ['merge with duplicate inputIndex', (q) => { q.checkpoints[3].dependsOn[1].inputIndex = 0; }, 'one dependency per input'],
    ['non-merge with two deps', (q) => { q.checkpoints[1].dependsOn = [{ node: 'B1 Is Paid', port: 0 }, { node: 'B1 Is Paid', port: 1, inputIndex: 1 }]; }, 'exactly one dependency'],
    ['negative dependsOn port', (q) => { q.checkpoints[1].dependsOn = { node: 'B1 Is Paid', port: -1 }; }, 'non-negative'],
    ['two contracts on one port', (q) => { q.checkpoints[0].contract[1].port = 0; }, 'one contract per output port'],
    ['empty contract array', (q) => { q.checkpoints[0].contract = []; }, 'structural contract'],
  ]) {
    p = clone(branch); mut(p);
    f = route.validate(route.assemble(p), p);
    add(`BR-5: refused: ${label}`, f.some((x) => x.includes(expect)), f);
  }
  s = bSealed(sealed.fixture, 3, []); s.assertions.push({ kind: 'items_eq_ordered', role: 'all', value: [] });
  r = await scoreSealed(branch, s);
  add('BR-6: wrong sealed value on a branch role still fails', r.pass === false, r.assertions);

  const src = clone(d09.checkpoints[0].node);
  const sink = clone(d10.checkpoints.find((c) => c.node.sideEffect).node);
  const credPlan = {
    task: 'ctl-cred', settings: { executionOrder: 'v1' }, input: { kind: 'pinned_node' },
    requiredUserSetup: [...d09.requiredUserSetup, ...d10.requiredUserSetup].map((x) => ({ ...x, neededBy: (x.neededBy || []).map((id) => ({ CP0: 'C0', CP1: 'C1', CP3: 'C3' })[id]).filter(Boolean) })),
    checkpoints: [
      { id: 'C0', dependsOn: { node: '@trigger', port: 0 }, node: src, contract: { cardinality: 'items', fields: { row_number: 'number', name: 'string', email: 'string', status: 'string' } } },
      { id: 'C1', dependsOn: { node: src.name, port: 0 }, node: { name: 'C1 New Only', type: 'n8n-nodes-base.filter', typeVersion: 2.3, parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'n', leftValue: '={{ $json.status }}', rightValue: 'new', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} } },
        contract: { cardinality: 'items', fields: { row_number: 'number', name: 'string', email: 'string', status: 'string' } } },
      { id: 'C2', dependsOn: { node: 'C1 New Only', port: 0 }, node: { name: 'C2 Compose', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { assignments: { assignments: [{ id: 'x', name: 'text', type: 'string', value: '=New lead: {{ $json.name }} <{{ $json.email }}>' }] }, includeOtherFields: false, options: {} } },
        contract: { cardinality: 'items', fields: { text: 'string' } } },
      { id: 'C3', dependsOn: { node: 'C2 Compose', port: 0 }, node: sink, contract: { cardinality: 'items', fields: { text: 'string' } } },
    ],
    outputBindings: { posts: { node: sink.name, port: 0 } },
  };
  const credFixture = [{ row_number: 2, name: 'Ann', email: 'ann@x.test', status: 'new' }, { row_number: 3, name: 'Bob', email: 'bob@x.test', status: 'old' }];
  const credSealed = { task: 'ctl-cred', fixture: credFixture, assertions: [{ kind: 'count_eq', role: 'posts', value: 1 }, { kind: 'items_eq_ordered', role: 'posts', value: [{ text: 'New lead: Ann <ann@x.test>' }] }] };
  f = route.validate(route.assemble(credPlan), credPlan);
  add('SNK-0: pinned-source + declared-sink plan validates clean (setup declared)', f.length === 0, f);
  r = await scoreSealed(credPlan, credSealed);
  add('SNK-1: sink role = rendered params; no send, no credential lookup', r.pass === true && r.executedSinks === 0 && r.credentialLookups === 0 && r.unsafeExecuted === 0, r);
  s = clone(credSealed); s.assertions[1].value = [{ text: 'New lead: Ann' }];
  r = await scoreSealed(credPlan, s);
  add('SNK-2: wrong rendered sink text fails', r.pass === false, r.assertions);
  p = clone(credPlan); p.checkpoints[3].node.sideEffect = false;
  f = route.validate(route.assemble(p), p);
  add('SNK-3: undeclared sink refused (not offline-safe)', f.some((x) => x.includes('not offline-safe')), f);

  // --- v3.6.1: setup exemptions are node-local (Operator @ c154d4e) ---
  const cpx = (q, setupForCpx) => { q.checkpoints.push({ id: 'CPX', dependsOn: { node: '@trigger', port: 0 }, node: { ...clone(q.checkpoints[0].node), name: 'CPX Second Sheet' }, contract: { cardinality: 'items', fields: { x: 'string' } } }); if (setupForCpx) q.requiredUserSetup.push({ kind: 'resource', param: 'documentId', neededBy: ['CPX'] }); return q; };
  p = cpx(clone(d09), false);
  add('SETUP-1: CP0 documentId declaration no longer silences a second pinned node (CPX)', nr(p).some((x) => x.startsWith('CPX Second Sheet')) && !nr(p).some((x) => x.startsWith('CP0 ')), nr(p));
  p = cpx(clone(d09), true);
  add('SETUP-2: CPX with its own declaration is clean', nr(p).length === 0, nr(p));
  p = clone(d09); p.requiredUserSetup = p.requiredUserSetup.map((x) => (x.param === 'documentId' ? { ...x, neededBy: ['CP1'] } : x));
  add('SETUP-3: declaration scoped to a different checkpoint does not exempt CP0', nr(p).some((x) => x.startsWith('CP0 ') && x.includes('documentId')), nr(p));
  for (const [label, bad] of [['missing neededBy', { param: 'documentId' }], ['unknown checkpoint id', { param: 'documentId', neededBy: ['NOPE'] }], ['empty param', { param: '', neededBy: ['CP0'] }]]) {
    p = clone(d09); p.requiredUserSetup.push(bad);
    add(`SETUP-4: malformed setup declaration refused (${label})`, nr(p).some((x) => x.startsWith('requiredUserSetup[')), nr(p));
  }

  // --- v3.7: switch with 3 outputs, one role per output, one output empty ---
  const rule = (v, key) => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: key, leftValue: '={{ $json.status }}', rightValue: v, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: false });
  const sw = {
    task: 'ctl-switch', settings: { executionOrder: 'v1' }, input: { kind: 'trigger_items' },
    checkpoints: [{ id: 'S1', dependsOn: { node: '@trigger', port: 0 }, node: { name: 'S1 Route Status', type: 'n8n-nodes-base.switch', typeVersion: 3.2,
      parameters: { rules: { values: [rule('paid', 'p'), rule('open', 'o'), rule('void', 'v')] }, options: {} } },
    contract: [0, 1, 2].map((port) => ({ port, cardinality: 'items', fields: row })) }],
    outputBindings: { paid: { node: 'S1 Route Status', port: 0 }, open: { node: 'S1 Route Status', port: 1 }, void: { node: 'S1 Route Status', port: 2 } },
  };
  f = route.validate(route.assemble(sw), sw);
  add('SW-0: switch@3.2 with 3 per-port contracts validates clean', f.length === 0, f);
  r = await scoreSealed(sw, { task: 'ctl-switch', fixture: sealed.fixture, assertions: [{ kind: 'count_eq', role: 'paid', value: 2 }, { kind: 'count_eq', role: 'open', value: 1 }, { kind: 'count_eq', role: 'void', value: 0 }] });
  add('SW-1: switch routes 2/1/0; empty output port reads as [] from an EXECUTED node', r.pass === true, r);
  p = clone(sw); p.outputBindings.void = { node: 'S1 Route Status', port: 3 };
  r = await scoreSealed(p, { task: 'ctl-switch', fixture: sealed.fixture, assertions: [{ kind: 'count_eq', role: 'paid', value: 2 }, { kind: 'count_eq', role: 'open', value: 1 }, { kind: 'count_eq', role: 'void', value: 0 }] });
  add('SW-2: switch port 3 (beyond its 3 outputs) refused statically', r.pass === false && r.refused === true && r.validatorFindings.some((x) => x.includes('port 3 does not exist')), r.validatorFindings);
  { const ex = await route.execute(route.assemble(p), p, sealed.fixture); add('SW-2-rt: runtime guard still errors on switch port 3', ex.bindingErrors.length === 1, ex.bindingErrors); }

  // ===================== v3.8 (Demo 4, Google family) =====================
  const trig = (id, name, node, contract, dep = { node: '@trigger', port: 0 }) => ({ id, dependsOn: dep, node: { name, ...node }, contract });
  const setN = (assign) => ({ type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { assignments: { assignments: assign.map(([n, v, t = 'string'], i) => ({ id: `a${i}`, name: n, type: t, value: v })) }, includeOtherFields: false, options: {} } });
  const people = [{ name: 'Ann', email: 'ann@x.test', qty: 5 }, { name: 'Bob', email: 'bob@x.test', qty: 0 }];
  const sinkPlan = (sinkNode, fields) => ({
    task: 'ctl-sink', settings: { executionOrder: 'v1' }, input: { kind: 'trigger_items' },
    checkpoints: [
      trig('K1', 'K1 Keep', setN([['name', '={{ $json.name }}'], ['email', '={{ $json.email }}'], ['qty', '={{ $json.qty }}', 'number']]), { cardinality: 'items', fields: { name: 'string', email: 'string', qty: 'number' } }),
      { id: 'K2', dependsOn: { node: 'K1 Keep', port: 0 }, node: { name: 'K2 Google Write', sideEffect: true, ...sinkNode }, contract: { cardinality: 'items', fields } },
    ],
    outputBindings: { writes: { node: 'K2 Google Write', port: 0 } },
    requiredUserSetup: [],
  });
  const sinkScore = async (q, items) => scoreSealed(q, { task: 'ctl-sink', fixture: people, assertions: [{ kind: 'count_eq', role: 'writes', value: items.length }, { kind: 'items_eq_ordered', role: 'writes', value: items }] });
  const gmailSend = { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: { resource: 'message', operation: 'send', sendTo: '={{ $json.email }}', subject: 'Stock report', emailType: 'text', message: '=Hi {{ $json.name }}, qty {{ $json.qty }}', options: {} } };
  r = await sinkScore(sinkPlan(gmailSend, { sendTo: 'string', subject: 'string', message: 'string' }), [{ sendTo: 'ann@x.test', subject: 'Stock report', message: 'Hi Ann, qty 5' }, { sendTo: 'bob@x.test', subject: 'Stock report', message: 'Hi Bob, qty 0' }]);
  add('V8-R1: gmail send renders {sendTo, subject, message} (static + expr) as strings; nothing sent', r.pass === true && r.executedSinks === 0 && r.credentialLookups === 0, r);
  const sheetsAppend = (columns) => ({ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, parameters: { authentication: 'oAuth2', resource: 'sheet', operation: 'append', documentId: { __rl: true, mode: 'url', value: '' }, sheetName: { __rl: true, mode: 'name', value: 'Log' }, columns, options: {} } });
  let sp = sinkPlan(sheetsAppend({ mappingMode: 'defineBelow', value: { who: '={{ $json.name }}', qty: '={{ $json.qty }}' }, matchingColumns: [], schema: [] }), { who: 'string', qty: 'string', '@sheetName': 'string' });
  sp.requiredUserSetup = [{ kind: 'resource', param: 'documentId', neededBy: ['K2'] }];
  r = await sinkScore(sp, [{ who: 'Ann', qty: '5', '@sheetName': 'Log' }, { who: 'Bob', qty: '0', '@sheetName': 'Log' }]);
  add('V8-R2: sheets append (define below) renders nested columns.value.* as flat string keys', r.pass === true, r);
  sp = sinkPlan(sheetsAppend({ mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] }), { name: 'string', email: 'string', qty: 'number', '@sheetName': 'string' });
  sp.requiredUserSetup = [{ kind: 'resource', param: 'documentId', neededBy: ['K2'] }];
  r = await sinkScore(sp, people.map((x) => ({ ...x, '@sheetName': 'Log' })));
  add('V8-R3: sheets append (autoMap) renders the input item unchanged (types kept)', r.pass === true, r);
  const calCreate = { type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, parameters: { resource: 'event', operation: 'create', calendar: { __rl: true, mode: 'list', value: '' }, start: '2026-10-01T09:00:00', end: '2026-10-01T09:30:00', useDefaultReminders: true, additionalFields: { summary: '=Restock {{ $json.name }}' } } };
  sp = sinkPlan(calCreate, { start: 'string', end: 'string', summary: 'string' });
  sp.requiredUserSetup = [{ kind: 'resource', param: 'calendar', neededBy: ['K2'] }];
  r = await sinkScore(sp, [{ start: '2026-10-01T09:00:00', end: '2026-10-01T09:30:00', summary: 'Restock Ann' }, { start: '2026-10-01T09:00:00', end: '2026-10-01T09:30:00', summary: 'Restock Bob' }]);
  add('V8-R4: calendar create renders {start, end, summary}', r.pass === true, r);
  p = sinkPlan({ ...gmailSend, parameters: { ...gmailSend.parameters, operation: 'reply' } }, { x: 'string' });
  f = route.validate(route.assemble(p), p);
  add('V8-R5: unknown sink operation (gmail reply) fails closed', f.some((x) => x.includes('no render rule')), f);
  sp = sinkPlan(sheetsAppend({ mappingMode: 'defineBelow', value: { who: { nested: 1 } }, matchingColumns: [], schema: [] }), { who: 'string' });
  sp.requiredUserSetup = [{ kind: 'resource', param: 'documentId', neededBy: ['K2'] }];
  f = route.validate(route.assemble(sp), sp);
  add('V8-R6: non-scalar sink content refused', f.some((x) => x.includes('not a scalar')), f);

  const sheetsRead = (name) => ({ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, credential: 'pinned', parameters: { authentication: 'oAuth2', resource: 'sheet', operation: 'read', documentId: { __rl: true, mode: 'url', value: '' }, sheetName: { __rl: true, mode: 'name', value: name }, filtersUI: {}, options: {} } });
  const joinPlan = () => ({
    task: 'ctl-join', settings: { executionOrder: 'v1' }, input: { kind: 'pinned_nodes' },
    checkpoints: [
      trig('J1', 'J1 Read Orders', { ...sheetsRead('Orders'), pinKey: 'Orders sheet' }, { cardinality: 'items', fields: { row_number: 'number', orderId: 'string', customerId: 'string' } }),
      trig('J2', 'J2 Read Customers', { ...sheetsRead('Customers'), pinKey: 'Customers sheet', executeOnce: true }, { cardinality: 'items', fields: { row_number: 'number', customerId: 'string', email: 'string' } }, { node: 'J1 Read Orders', port: 0 }),
      { id: 'J3', dependsOn: [{ node: 'J1 Read Orders', port: 0, inputIndex: 0 }, { node: 'J2 Read Customers', port: 0, inputIndex: 1 }],
        node: { name: 'J3 Join By Customer', type: 'n8n-nodes-base.merge', typeVersion: 3.2, parameters: { mode: 'combine', combineBy: 'combineByFields', fieldsToMatchString: 'customerId', joinMode: 'keepMatches', options: {} } },
        contract: { cardinality: 'items', fields: { row_number: 'number', orderId: 'string', customerId: 'string', email: 'string' } } },
    ],
    outputBindings: { joined: { node: 'J3 Join By Customer', port: 0 } },
    requiredUserSetup: [{ kind: 'resource', param: 'documentId', neededBy: ['J1', 'J2'] }],
  });
  const joinFx = { 'Orders sheet': [{ row_number: 2, orderId: 'o1', customerId: 'c1' }, { row_number: 3, orderId: 'o2', customerId: 'c9' }], 'Customers sheet': [{ row_number: 2, customerId: 'c1', email: 'c1@x.test' }] };
  const joinSealed = (fx) => ({ task: 'ctl-join', fixtures: fx, assertions: [{ kind: 'count_eq', role: 'joined', value: 1 }, { kind: 'field_set_eq', role: 'joined', value: ['row_number', 'orderId', 'customerId', 'email'] }] });
  p = joinPlan(); f = route.validate(route.assemble(p), p);
  add('V8-P0: two pinned Sheets reads (one mid-flow, executeOnce) + merge-by-key validates clean', f.length === 0, f);
  r = await scoreSealed(p, joinSealed(joinFx));
  add('V8-P1: labelled fixtures pin both reads; join passes; no credential lookup', r.pass === true && r.credentialLookups === 0 && r.unsafeExecuted === 0, r);
  r = await scoreSealed(p, joinSealed({ 'Orders sheet': joinFx['Orders sheet'], 'Clients sheet': joinFx['Customers sheet'] }));
  add('V8-P2: fixture labels that do not match the plan pinKeys are refused before execution', r.refused === true && (r.taskBindingFindings || []).some((x) => x.includes('pin mismatch')), r);
  r = await scoreSealed(p, { task: 'ctl-join', fixture: joinFx['Orders sheet'], assertions: [{ kind: 'count_eq', role: 'joined', value: 1 }] });
  add('V8-P3: a single array fixture with two pinned nodes is refused', r.refused === true, r);
  p = joinPlan(); delete p.checkpoints[1].node.executeOnce; f = route.validate(route.assemble(p), p);
  add('V8-P4a: mid-flow pinned read without executeOnce refused', f.some((x) => x.includes('executeOnce')), f);
  p = joinPlan(); p.checkpoints[1].node.parameters.sheetName.value = '={{ $json.customerId }}'; f = route.validate(route.assemble(p), p);
  add('V8-P4b: mid-flow pinned read with an item-dependent expression refused', f.some((x) => x.includes('item-dependent')), f);
  p = joinPlan(); p.checkpoints[1].node.parameters.operation = 'append'; p.checkpoints[1].node.parameters.columns = { mappingMode: 'autoMapInputData', value: {} };
  f = route.validate(route.assemble(p), p);
  add('V8-P5a: pinned node with no cited shape (sheets append as source) fails closed', f.some((x) => x.includes('no cited output shape')), f);
  route.setShapeRegistry(null); p = joinPlan(); f = route.validate(route.assemble(p), p);
  add('V8-P5b: no registry loaded -> every pinned node fails closed', f.some((x) => x.includes('no audited pinned-shape registry')), f);
  route.setShapeRegistry({ shapes: [{ ...SYNTH_SHAPES.shapes[0], shape: 'api-passthrough', fields: {} }] }); f = route.validate(route.assemble(p), p);
  add('V8-P5c: api-passthrough shape fails closed', f.some((x) => x.includes('api-passthrough')), f);
  route.setShapeRegistry({ shapes: [{ ...SYNTH_SHAPES.shapes[0], citations: ['see the source'] }] }); f = route.validate(route.assemble(p), p);
  add('V8-P5d: shape entry without file:line citations fails closed', f.some((x) => x.includes('file:line')), f);
  route.setShapeRegistry({ shapes: [SYNTH_SHAPES.shapes[0], SYNTH_SHAPES.shapes[0]] }); f = route.validate(route.assemble(p), p);
  add('V8-P5e: ambiguous registry match fails closed', f.some((x) => x.includes('ambiguous')), f);
  route.setShapeRegistry(SYNTH_SHAPES);
  p = joinPlan(); delete p.checkpoints[0].contract.fields.row_number; f = route.validate(route.assemble(p), p);
  add('V8-P6: pinned contract missing a cited fixed field (row_number) refused', f.some((x) => x.includes('cited output shape')), f);
  p = joinPlan(); p.checkpoints[1].node.pinKey = 'Orders sheet'; f = route.validate(route.assemble(p), p);
  add('V8-P7: duplicate pinKey refused', f.some((x) => x.startsWith('pinKey')), f);

  let wfL = route.assemble(branch);
  const pos = wfL.nodes.map((n) => n.position.join(','));
  const at = (nm) => wfL.nodes.find((n) => n.name === nm).position;
  add('V8-L1: layout: no two nodes overlap; branch outputs share a column on different rows; trigger at x=0',
    new Set(pos).size === pos.length && at('B2 Tag Paid')[0] === at('B3 Tag Open')[0] && at('B2 Tag Paid')[1] !== at('B3 Tag Open')[1] && wfL.nodes[0].position[0] === 0 && at('B4 Merge')[0] > at('B2 Tag Paid')[0], wfL.nodes.map((n) => [n.name, n.position]));
  wfL = route.assemble(joinPlan());
  add('V8-L2: executeOnce is carried into the assembled workflow', wfL.nodes.find((n) => n.name === 'J2 Read Customers').executeOnce === true);
  p = clone(plan); p.checkpoints[0].node.name = 'x'.repeat(65); p.checkpoints[1].dependsOn = { node: p.checkpoints[0].node.name, port: 0 };
  f = route.validate(route.assemble(p), p);
  add('V8-N1: node name over 64 characters refused (canvas readability)', f.some((x) => x.includes('1–64')), f);

  // ===================== v3.8.1 (Operator @ 885a83c) =====================
  // (1) exact registry selectors
  const readD09 = sheetsRead('Orders');
  const onePin = (node) => ({ task: 'ctl-one', settings: { executionOrder: 'v1' }, input: { kind: 'pinned_node' },
    checkpoints: [trig('Q1', node.name || 'Q1 Read', { ...node, name: node.name || 'Q1 Read' }, { cardinality: 'items', fields: { row_number: 'number', a: 'string' } })],
    outputBindings: { rows: { node: node.name || 'Q1 Read', port: 0 } }, requiredUserSetup: [{ kind: 'resource', param: 'documentId', neededBy: ['Q1'] }] });
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, fields: { row_number: 'number' }, extra: 'sheet-columns', citations: ['SYNTHETIC/x.js:1'] }] });
  p = onePin(readD09); f = route.validate(route.assemble(p), p);
  add('REG-1a: registry entry without resource/operation matches nothing (read refused)', f.some((x) => x.includes('no cited output shape')), f);
  p = onePin({ ...readD09, parameters: { ...readD09.parameters, operation: 'append', columns: { mappingMode: 'autoMapInputData', value: {} } } }); f = route.validate(route.assemble(p), p);
  add('REG-1b: ...and the changed append plan is refused too', f.some((x) => x.includes('no cited output shape')), f);
  const gmailGetAll = { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, credential: 'pinned', name: 'Q1 Mail', parameters: { resource: 'message', operation: 'getAll', returnAll: false, limit: 10, simple: true, filters: {} } };
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.gmail', typeVersion: 2.1, resource: 'message', operation: 'getAll', fields: { row_number: 'number', a: 'string' }, citations: ['SYNTHETIC/x.js:1'] }] });
  p = onePin(gmailGetAll); f = route.validate(route.assemble(p), p);
  add('REG-2a: gmail getAll entry without the output-mode qualifier when.simple is invalid (refused)', f.some((x) => x.includes('no cited output shape')), f);
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.gmail', typeVersion: 2.1, resource: 'message', operation: 'getAll', when: { simple: false }, fields: { row_number: 'number', a: 'string' }, citations: ['SYNTHETIC/x.js:1'] }] });
  f = route.validate(route.assemble(p), p);
  add('REG-2b: gmail simple=true node does not match a simple=false entry', f.some((x) => x.includes('no cited output shape')), f);
  route.setShapeRegistry(SYNTH_SHAPES);
  // (2) reserved names / own pin keys
  for (const nm of ['__proto__', 'constructor', 'toString']) {
    p = onePin({ ...readD09, name: nm }); f = route.validate(route.assemble(p), p);
    const pp = route.pinPlan(p, [{ row_number: 2, a: 'x' }], 'Trigger');
    add(`PINR-1: pinned node named ${nm} refused by validate and by pinPlan`, f.some((x) => x.includes('reserved node name')) && Boolean(pp.error), { f, pp: pp.error });
  }
  p = onePin(readD09); const ppOk = route.pinPlan(p, [{ row_number: 2, a: 'x' }], 'Trigger');
  add('PINR-2: normal pin map is a plain object whose own keys are exactly the pinned nodes', !ppOk.error && Object.keys(ppOk.pinData).join() === 'Q1 Read' && Object.getPrototypeOf(ppOk.pinData) === Object.prototype, ppOk);
  r = await scoreSealed(p, { task: 'ctl-one', fixture: [{ row_number: 2, a: 'x' }], assertions: [{ kind: 'count_eq', role: 'rows', value: 1 }] });
  add('PINR-3: pinned read is never executed (unsafeExecuted 0, no credential lookup) and passes', r.pass === true && r.unsafeExecuted === 0 && r.credentialLookups === 0, r);
  // (3) Sheets update routing: row selector + tab are rendered separately from content
  const sheetsUpdate = (match) => ({ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, parameters: { authentication: 'oAuth2', resource: 'sheet', operation: 'update', documentId: { __rl: true, mode: 'url', value: '' }, sheetName: { __rl: true, mode: 'name', value: 'Stock' },
    columns: { mappingMode: 'defineBelow', value: { who: '={{ $json.name }}', qty: '={{ $json.qty }}' }, matchingColumns: match, schema: [] }, options: {} } });
  const updPlan = (match) => { const q = sinkPlan(sheetsUpdate(match), { who: 'string', qty: 'string', '@sheetName': 'string', '@matchingColumns': 'string' }); q.requiredUserSetup = [{ kind: 'resource', param: 'documentId', neededBy: ['K2'] }]; return q; };
  const updExpect = people.map((x) => ({ who: x.name, qty: String(x.qty), '@sheetName': 'Stock', '@matchingColumns': '["who"]' }));
  r = await sinkScore(updPlan(['who']), updExpect);
  add('UPD-1: sheets update renders @matchingColumns and @sheetName (who) and passes', r.pass === true, r);
  r = await sinkScore(updPlan(['qty']), updExpect);
  add('UPD-2: the same update matching on the WRONG column (qty) now fails the sealed assertion', r.pass === false && r.assertions.some((a) => !a.pass), r.assertions);
  const wfA = route.verificationWorkflow(route.assemble(updPlan(['who'])), updPlan(['who'])).wf; const wfB = route.verificationWorkflow(route.assemble(updPlan(['qty'])), updPlan(['qty'])).wf;
  add('UPD-3: the two render probes differ', JSON.stringify(wfA.nodes.find((n) => n.name === 'K2 Google Write').parameters) !== JSON.stringify(wfB.nodes.find((n) => n.name === 'K2 Google Write').parameters));
  { // v3.8.2: comma-containing header vs two headers must render differently (Operator @ 624f193)
    const one = route.verificationWorkflow(route.assemble(updPlan(['who,qty'])), updPlan(['who,qty'])).wf.nodes.find((n) => n.name === 'K2 Google Write').parameters.assignments.assignments.find((a) => a.name === '@matchingColumns').value;
    const two = route.verificationWorkflow(route.assemble(updPlan(['who', 'qty'])), updPlan(['who', 'qty'])).wf.nodes.find((n) => n.name === 'K2 Google Write').parameters.assignments.assignments.find((a) => a.name === '@matchingColumns').value;
    add('UPD-5: ["who,qty"] and ["who","qty"] render as distinct exact JSON encodings', one === '["who,qty"]' && two === '["who","qty"]', { one, two });
    r = await sinkScore(updPlan(['who,qty']), people.map((x) => ({ who: x.name, qty: String(x.qty), '@sheetName': 'Stock', '@matchingColumns': '["who","qty"]' })));
    add('UPD-6: a sealed assertion for two match columns fails on the one comma-header plan', r.pass === false, r.assertions);
  }
  sp = sinkPlan(sheetsAppend({ mappingMode: 'defineBelow', value: { '@sheetName': 'x' }, matchingColumns: [], schema: [] }), { '@sheetName': 'string' });
  sp.requiredUserSetup = [{ kind: 'resource', param: 'documentId', neededBy: ['K2'] }];
  f = route.validate(route.assemble(sp), sp);
  add('UPD-4: a content column named with the reserved "@" prefix is refused', f.some((x) => x.includes('reserved for routing')), f);

  // --- v3.8.3: registry `when` is evaluated on n8n defaults (top-level and collection children) ---
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, resource: 'sheet', operation: 'read', when: { 'options.returnFirstMatch': false }, fields: { row_number: 'number' }, extra: 'sheet-columns', citations: ['SYNTHETIC/x.js:1'] }] });
  p = onePin(readD09); f = route.validate(route.assemble(p), p);
  add('DEF-1: a plan omitting options.returnFirstMatch matches an entry pinned to its default (false)', f.length === 0, f);
  p = onePin({ ...readD09, parameters: { ...readD09.parameters, options: { returnFirstMatch: true } } }); f = route.validate(route.assemble(p), p);
  add('DEF-2: an explicit non-default value (true) does not match', f.some((x) => x.includes('no cited output shape')), f);
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.gmail', typeVersion: 2.1, resource: 'message', operation: 'getAll', when: { simple: true }, fields: { row_number: 'number', a: 'string' }, citations: ['SYNTHETIC/x.js:1'] }] });
  const noSimple = { ...gmailGetAll, parameters: { ...gmailGetAll.parameters } }; delete noSimple.parameters.simple;
  p = onePin(noSimple); f = route.validate(route.assemble(p), p);
  add('DEF-3: a gmail plan omitting simple matches when.simple:true (its n8n default)', !f.some((x) => x.includes('no cited output shape')), f);
  // --- v3.8.4: unknown qualifier paths never match (Operator @ 23c5029) ---
  for (const [label, when] of [['options.NO_SUCH_FIELD:null', { 'options.NO_SUCH_FIELD': null }], ['NO_SUCH_TOP:null', { NO_SUCH_TOP: null }], ['options.NO_SUCH_FIELD:-as-missing', { 'options.NO_SUCH_FIELD': false }]]) {
    route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, resource: 'sheet', operation: 'read', when, fields: { row_number: 'number' }, extra: 'sheet-columns', citations: ['SYNTHETIC/x.js:1'] }] });
    p = onePin(readD09); f = route.validate(route.assemble(p), p);
    add(`DEF-4: unknown qualifier path never matches (${label})`, f.some((x) => x.includes('no cited output shape')), f);
  }
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, resource: 'sheet', operation: 'read', when: { 'options.returnFirstMatch': false }, fields: { row_number: 'number' }, extra: 'sheet-columns', citations: ['SYNTHETIC/x.js:1'] }] });
  p = onePin(readD09); f = route.validate(route.assemble(p), p);
  add('DEF-5: the known default case (DEF-1) still matches after the fix', f.length === 0, f);
  // --- v3.8.5: nested qualifier children must be DISPLAYED for the node version (Operator @ ff39f85) ---
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.4, resource: 'sheet', operation: 'read', when: { 'options.returnFirstMatch': false }, fields: { row_number: 'number' }, extra: 'sheet-columns', citations: ['SYNTHETIC/x.js:1'] }] });
  p = onePin({ ...readD09, typeVersion: 4.4 }); f = route.validate(route.assemble(p), p);
  add('DEF-6: Sheets@4.4 hides options.returnFirstMatch (@version>=4.5), so a qualifier on it never matches', f.some((x) => x.includes('no cited output shape')), f);
  route.setShapeRegistry({ shapes: [{ type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, resource: 'sheet', operation: 'read', when: { 'options.returnFirstMatch': false }, fields: { row_number: 'number' }, extra: 'sheet-columns', citations: ['SYNTHETIC/x.js:1'] }] });
  p = onePin(readD09); f = route.validate(route.assemble(p), p);
  add('DEF-7: ...while on Sheets@4.7 the same visible default still matches', f.length === 0, f);
  route.setShapeRegistry(SYNTH_SHAPES);

  undefined



  for (const x of results) {
    assert.strictEqual(x.pass, true, "Control failed: " + x.label + " - why: " + JSON.stringify(x.why));
  }
  const passCount = results.filter((x) => x.pass).length;
  assert.strictEqual(passCount, 147, "Expected 147/147 passing controls, got " + passCount);
  console.log("V3_CONTROLS " + passCount + "/" + results.length + " PASS");
  process.exit(0);
});
