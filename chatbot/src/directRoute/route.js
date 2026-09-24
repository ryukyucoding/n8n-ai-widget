'use strict';

// X1 direct route: plan (n8n-native parameters) -> n8n workflow JSON -> thin
// validator (fail closed) -> offline execution with the trigger pinned to the
// fixture -> checkpoint assertions. No per-task code: everything is data-driven.

const fs = require('node:fs');
const path = require('node:path');
const { NodeHelpers } = require('n8n-workflow');
const { executeOffline } = require('./harness');

const CATALOG = require('./runtime_node_schemas.json').nodeTypes; // = product HEAD blob bec71944
const { VERIFIED_PATTERN_HOSTS } = require('./publicUrlPolicy');       // = product HEAD blob ed4d867f
const DENIED = require('./e3a-report.json').excluded;                         // network/fs/command/instance/LLM nodes
const PKG_FILES = require('n8n-nodes-base/package.json').n8n.nodes;
const TRIGGER = { name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 };
const IF_VERSION = 2.2;
const TIME_SENSITIVE = /\$now|\$today|DateTime\.|new Date\(/;

// --- assemble -----------------------------------------------------------------
function assemble(plan) {
  const nodes = [{ id: 'trigger', ...TRIGGER, position: [0, 0], parameters: {} }];
  const connections = {};
  plan.checkpoints.forEach((cp, i) => {
    const n = cp.node;
    nodes.push({ id: `n${i + 1}`, name: n.name, type: n.type, typeVersion: n.typeVersion, position: [220 * (i + 1), 0], parameters: n.parameters || {}, ...(n.credentials ? { credentials: n.credentials } : {}) });
    const from = cp.dependsOn.node === '@trigger' ? TRIGGER.name : cp.dependsOn.node;
    connections[from] = connections[from] || { main: [] };
    const ports = connections[from].main;
    while (ports.length <= cp.dependsOn.port) ports.push([]);
    ports[cp.dependsOn.port].push({ node: n.name, type: 'main', index: cp.dependsOn.inputIndex || 0 });
  });
  return { name: `X1 ${plan.task}`, nodes, connections, settings: { ...plan.settings } };
}

// --- thin validator (fail closed) ---------------------------------------------
function hostOf(url) { try { return new URL(url).hostname; } catch { return null; } }
function validate(workflow, plan) {
  const findings = [];
  const allowedKeys = new Set(['name', 'nodes', 'connections', 'settings']);
  for (const k of Object.keys(workflow)) if (!allowedKeys.has(k)) findings.push(`workflow: unexpected top-level key ${k}`);
  const names = new Set(workflow.nodes.map((n) => n.name));
  if (names.size !== workflow.nodes.length) findings.push('workflow: duplicate node names');
  let timeSensitive = false;
  for (const n of workflow.nodes) {
    const where = `${n.name} (${n.type}@${n.typeVersion})`;
    const type = CATALOG[n.type];
    const desc = type?.versions?.[String(n.typeVersion)];
    if (!desc) { findings.push(`${where}: unknown type or version in runtime catalog`); continue; }
    if (DENIED[n.type]) findings.push(`${where}: denied (${DENIED[n.type]})`);
    const isTrigger = (desc.group || []).includes('trigger') || /trigger/i.test(n.type) || desc.polling || desc.webhooks;
    if (isTrigger && n.type !== TRIGGER.type) findings.push(`${where}: listener/trigger nodes other than manualTrigger are not allowed`);
    if (n.credentials) findings.push(`${where}: credentials present`);
    // A credential is required when its descriptor says so AND it is shown for
    // this node's actual parameters (e.g. httpRequest needs one only for SSL certs).
    const resolved = NodeHelpers.getNodeParameters(desc.properties, n.parameters, true, false, n, desc) || {};
    if ((desc.credentials || []).some((c) => c.required && NodeHelpers.displayParameter(resolved, c, n, desc))) findings.push(`${where}: node type requires credentials for these parameters`);
    if (n.type === 'n8n-nodes-base.if' && n.typeVersion !== IF_VERSION) findings.push(`${where}: if must be @${IF_VERSION}`);
    if (n.type === 'n8n-nodes-base.httpRequest' && !VERIFIED_PATTERN_HOSTS.includes(hostOf(n.parameters.url))) findings.push(`${where}: HTTP host not approved`);
    if (n.type === 'n8n-nodes-base.dateTime' || TIME_SENSITIVE.test(JSON.stringify(n.parameters))) timeSensitive = true;
    const issues = NodeHelpers.getNodeParametersIssues(desc.properties, n, desc);
    if (issues) findings.push(`${where}: n8n parameter issues ${JSON.stringify(issues.parameters || issues).slice(0, 160)}`);
  }
  if (timeSensitive && !workflow.settings?.timezone) findings.push('settings.timezone required: workflow is time-sensitive');
  for (const cp of plan.checkpoints) {
    if (!Array.isArray(cp.assertions) || !cp.assertions.some((a) => Number.isInteger(a.count))) findings.push(`${cp.id}: execution assertions (with count) are required`);
  }
  for (const [role, b] of Object.entries(plan.outputBindings || {})) {
    if (!names.has(b.node)) findings.push(`outputBindings.${role}: node ${b.node} does not exist`);
  }
  if (!plan.outputBindings || !Object.keys(plan.outputBindings).length) findings.push('outputBindings required');
  return findings;
}

// --- execute + assert ---------------------------------------------------------
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const multiset = (items) => items.map(canonical).sort();
function checkAssertion(items, a) {
  const errors = [];
  if (Number.isInteger(a.count) && items.length !== a.count) errors.push(`count ${items.length} != ${a.count}`);
  if (a.fieldSet) {
    const bad = items.find((it) => canonical(Object.keys(it).sort()) !== canonical([...a.fieldSet].sort()));
    if (bad) errors.push(`fieldSet ${canonical(Object.keys(bad).sort())} != ${canonical([...a.fieldSet].sort())}`);
  }
  if (a.items) {
    const ok = a.compare === 'multiset' ? canonical(multiset(items)) === canonical(multiset(a.items)) : canonical(items) === canonical(a.items);
    if (!ok) errors.push(`items (${a.compare || 'ordered'}) differ: got ${canonical(items).slice(0, 160)}`);
  }
  return errors;
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
  const run = await executeOffline(workflow, { pinData: { [TRIGGER.name]: fixture.map((json) => ({ json })) }, extraTypes: extraTypesFor(workflow) });
  const checkpoints = plan.checkpoints.map((cp) => {
    const out = run.outputs[cp.node.name];
    const errors = !out ? ['node not executed'] : out.executionStatus !== 'success' ? [`node ${out.executionStatus}: ${out.error}`]
      : cp.assertions.flatMap((a) => checkAssertion(out.main[a.port] || [], a));
    return { id: cp.id, node: cp.node.name, pass: errors.length === 0, errors };
  });
  const roleItems = Object.fromEntries(Object.entries(plan.outputBindings).map(([role, b]) => [role, run.outputs[b.node]?.main[b.port] || []]));
  return { status: run.status, checkpoints, roleItems, codeNodeApproximated: run.codeNodeApproximated, executedNodes: run.executedNodes.map((e) => e.node) };
}

// --- Gauge dev assertions (read from Gauge's public dev split, not re-typed) ---
function gaugeDevTasks() {
  const file = path.resolve(__dirname, '../../n8n-ai-widget-a2a-private/a2a/results/GAUGE_G1_BENCHMARK_V0_DESIGN_20260923.md');
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('[{"classes"'));
  if (!line) throw new Error('Gauge public dev split not found');
  return JSON.parse(line);
}
function gaugeScore(task, roleItems) {
  const results = task.fixtures.F0.assertions.map((a) => {
    const items = roleItems[a.role];
    if (!items) return { ...a, pass: false, why: `role ${a.role} unbound` };
    switch (a.kind) {
      case 'count_eq': return { kind: a.kind, role: a.role, pass: items.length === a.value };
      case 'field_set_eq': return { kind: a.kind, role: a.role, pass: items.every((it) => canonical(Object.keys(it).sort()) === canonical([...a.value].sort())) };
      case 'items_eq_ordered': return { kind: a.kind, role: a.role, pass: canonical(items) === canonical(a.value) };
      case 'items_eq_multiset': return { kind: a.kind, role: a.role, pass: canonical(multiset(items)) === canonical(multiset(a.value)) };
      default: return { kind: a.kind, role: a.role, pass: false, why: 'unscorable assertion kind (fail closed)' };
    }
  });
  return { pass: results.every((r) => r.pass), results };
}

module.exports = { assemble, validate, execute, gaugeDevTasks, gaugeScore, TRIGGER };
