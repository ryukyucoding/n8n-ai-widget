'use strict';

// X2 direct route v2 (route.js v1 stays frozen at d3073168). Adds, data-driven:
//  - input.kind "schedule": the plan's scheduleTrigger is validated statically
//    (expected cron + settings.timezone); verification substitutes a manual
//    trigger pinned with the fixture. Activation is never done here.
//  - node.credential === "pinned": a credential-requiring source node, allowed
//    only without credentials and only pinned with the fixture in verification.
//    Parameters listed in plan.requiredUserSetup[].param are exempt from the
//    n8n parameter-issue check (user supplies them later); all others are not.
//  - node.sideEffect === true: a credential-requiring sink that is NEVER executed.
//    Verification replaces it by a render probe (set@3.4) with the same name that
//    evaluates its expression parameters per item with the same engine.
// Everything else is identical to v1 (assemble / validate / execute / score).

const path = require('node:path');
const { NodeHelpers } = require('n8n-workflow');
const v1 = require('./route');
const { executeOffline } = require('./harness');

const CATALOG = require('./runtime_node_schemas.json').nodeTypes;
const MANUAL = { name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 };
const SCHEDULE = 'n8n-nodes-base.scheduleTrigger';
const PKG_FILES = require('n8n-nodes-base/package.json').n8n.nodes;

// Re-key a node's outgoing connections (merging, never overwriting with undefined).
function moveConnections(connections, from, to) {
  if (!connections[from]) return;
  const target = connections[to] || { main: [] };
  connections[from].main.forEach((port, i) => { target.main[i] = [...(target.main[i] || []), ...port]; });
  connections[to] = target;
  delete connections[from];
}

function assemble(plan) {
  const wf = v1.assemble(plan);
  if (plan.input?.kind === 'schedule') {
    const t = plan.trigger;
    wf.nodes[0] = { id: 'trigger', name: t.name, type: t.type, typeVersion: t.typeVersion, position: [0, 0], parameters: t.parameters };
    if (t.name !== MANUAL.name) moveConnections(wf.connections, MANUAL.name, t.name);
  }
  return wf;
}

const isIana = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
const cronsOf = (params) => (params?.rule?.interval || []).filter((r) => r.field === 'cronExpression').map((r) => r.expression);

function validate(workflow, plan) {
  const byName = new Map(plan.checkpoints.map((cp) => [cp.node.name, cp.node]));
  const setupParams = new Set((plan.requiredUserSetup || []).map((s) => s.param).filter(Boolean));
  const findings = [];
  // Re-use v1 for everything except the three new exemptions.
  for (const f of v1.validate(workflow, plan)) {
    const node = [...byName.values()].find((n) => f.startsWith(`${n.name} (`));
    if (node?.credential === 'pinned' || node?.sideEffect === true) {
      if (/requires credentials for these parameters/.test(f)) continue;           // allowed by declaration
      if (/n8n parameter issues/.test(f)) continue;                                 // re-checked below with setup exemptions
      // Webhook-capable app nodes (e.g. slack sendAndWait) are not triggers; real trigger types stay blocked.
      const d = CATALOG[node.type]?.versions?.[String(node.typeVersion)];
      if (f.includes('listener/trigger') &&!/trigger/i.test(node.type) && !(d?.group || []).includes('trigger')) continue;
    }
    if (plan.input?.kind === 'schedule' && f.startsWith(`${plan.trigger?.name} (`) && /listener\/trigger/.test(f)) continue; // re-checked below
    if (plan.input?.kind === 'schedule' && /settings\.timezone required/.test(f)) continue;                                // re-checked below
    findings.push(f);
  }
  for (const n of workflow.nodes) {
    const decl = byName.get(n.name);
    if (!(decl?.credential === 'pinned' || decl?.sideEffect === true)) continue;
    if (decl.credential === 'pinned' && decl.sideEffect === true) findings.push(`${n.name}: cannot be both pinned and side-effect`);
    if (/wait/i.test(String(n.parameters?.operation || ''))) findings.push(`${n.name}: waiting/listening operations are not allowed`);
    const desc = CATALOG[n.type]?.versions?.[String(n.typeVersion)];
    if (!desc) continue;
    const issues = NodeHelpers.getNodeParametersIssues(desc.properties, n, desc)?.parameters || {};
    const remaining = Object.keys(issues).filter((p) => !setupParams.has(p));
    if (remaining.length) findings.push(`${n.name}: n8n parameter issues outside declared user setup: ${remaining.join(', ')}`);
  }
  if (plan.input?.kind === 'schedule') {
    const t = workflow.nodes[0];
    if (t.type !== SCHEDULE) findings.push(`schedule input requires ${SCHEDULE}`);
    if (!CATALOG[t.type]?.versions?.[String(t.typeVersion)]) findings.push(`${t.name}: unknown scheduleTrigger version`);
    if (!workflow.settings?.timezone || !isIana(workflow.settings.timezone)) findings.push('schedule: settings.timezone must be a valid IANA zone');
    const expected = plan.trigger?.expectCron;
    if (!expected || JSON.stringify(cronsOf(t.parameters)) !== JSON.stringify([expected])) findings.push(`schedule: cron ${JSON.stringify(cronsOf(t.parameters))} != expected ${JSON.stringify(expected)}`);
  } else if (workflow.settings?.timezone === undefined && /\$now|DateTime\./.test(JSON.stringify(workflow.nodes))) {
    findings.push('settings.timezone required: workflow is time-sensitive');
  }
  return findings;
}

// Verification workflow: manual trigger instead of schedule; sinks -> render probes.
function verificationWorkflow(workflow, plan) {
  const wf = JSON.parse(JSON.stringify(workflow));
  if (plan.input?.kind === 'schedule') {
    const old = wf.nodes[0].name;
    wf.nodes[0] = { id: 'trigger', ...MANUAL, position: [0, 0], parameters: {} };
    if (old !== MANUAL.name) moveConnections(wf.connections, old, MANUAL.name);
  }
  const renders = {};
  for (const cp of plan.checkpoints.filter((c) => c.node.sideEffect === true)) {
    const i = wf.nodes.findIndex((n) => n.name === cp.node.name);
    const exprs = Object.entries(cp.node.parameters || {}).filter(([, v]) => typeof v === 'string' && v.startsWith('='));
    renders[cp.node.name] = exprs.map(([k]) => k);
    wf.nodes[i] = { id: wf.nodes[i].id, name: cp.node.name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: wf.nodes[i].position,
      parameters: { includeOtherFields: false, options: {}, assignments: { assignments: exprs.map(([k, v], j) => ({ id: `r${j}`, name: k, type: 'string', value: v })) } } };
  }
  return { wf, renders };
}

function extraTypesFor(workflow) {
  const extra = {};
  for (const n of workflow.nodes) {
    const base = n.type.replace('n8n-nodes-base.', '');
    const file = PKG_FILES.find((f) => f.toLowerCase().endsWith(`/${base.toLowerCase()}.node.js`));
    if (file) extra[n.type] = [file, path.basename(file, '.node.js')];
  }
  return extra;
}

async function execute(workflow, plan, fixture) {
  const { wf, renders } = verificationWorkflow(workflow, plan);
  const pinnedSource = plan.checkpoints.find((cp) => cp.node.credential === 'pinned');
  const pinTarget = plan.input?.kind === 'pinned_node' && pinnedSource ? pinnedSource.node.name : MANUAL.name;
  const credentialed = wf.nodes.filter((n) => (CATALOG[n.type]?.versions?.[String(n.typeVersion)]?.credentials || []).length).map((n) => n.type);
  const run = await executeOffline(wf, { pinData: { [pinTarget]: fixture.map((json) => ({ json })) }, extraTypes: extraTypesFor(wf), allowCredentialedTypes: credentialed });
  const executedSinks = run.executedNodes.filter((e) => plan.checkpoints.some((cp) => cp.node.sideEffect && cp.node.name === e.node && e.type !== 'n8n-nodes-base.set'));
  const checkpoints = plan.checkpoints.map((cp) => {
    const out = run.outputs[cp.node.name];
    const errors = !out ? ['node not executed'] : out.executionStatus !== 'success' ? [`node ${out.executionStatus}: ${out.error}`]
      : (cp.assertions || []).flatMap((a) => v1Check(out.main[a.port] || [], a));
    return { id: cp.id, node: cp.node.name, pass: errors.length === 0, errors };
  });
  const roleItems = Object.fromEntries(Object.entries(plan.outputBindings).map(([role, b]) => [role, run.outputs[b.node]?.main[b.port] || []]));
  return { status: run.status, checkpoints, roleItems, renders, pinTarget, credentialLookups: run.credentialLookups.length, executedSinks: executedSinks.length, codeNodeApproximated: run.codeNodeApproximated };
}

// Same assertion semantics as v1 (count / fieldSet / ordered|multiset items).
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function v1Check(items, a) {
  const e = [];
  if (Number.isInteger(a.count) && items.length !== a.count) e.push(`count ${items.length} != ${a.count}`);
  if (a.fieldSet && items.some((it) => canon(Object.keys(it).sort()) !== canon([...a.fieldSet].sort()))) e.push('fieldSet');
  if (a.items) {
    const ms = (xs) => xs.map(canon).sort();
    if (a.compare === 'multiset' ? canon(ms(items)) !== canon(ms(a.items)) : canon(items) !== canon(a.items)) e.push(`items differ: ${canon(items).slice(0, 120)}`);
  }
  return e;
}

module.exports = { assemble, validate, execute, gaugeDevTasks: v1.gaugeDevTasks, gaugeScore: v1.gaugeScore, verificationWorkflow };
