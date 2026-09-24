'use strict';

// Direct route v3: "E2E mode" for unseen requests (Demo 2 / E2E-3). Builds on
// v2 (frozen 378c5b53) and v1 (frozen d3073168); neither file changes.
// A planner that never sees fixtures cannot know item counts, so in E2E mode:
//  - each checkpoint declares a STRUCTURAL contract instead of count assertions:
//      contract: { cardinality: "items" | "one", port?: 0,
//                  fields: { <name>: "string"|"number"|"boolean"|"object"|"array", optionally "|null" / "|absent" } }
//  - the mandatory execution assertions are Gauge's SEALED role assertions,
//    supplied only at scoring time (score-e2e.js). Scoring refuses any bound
//    role without a count assertion, and execution status is never a pass.

const path = require('node:path');
const { NodeHelpers } = require('n8n-workflow');
const v2 = require('./route2');
const { executeOffline, WHITELIST } = require('./harness');

// Zero-network execution allowlist for E2E scoring. Only these types may run;
// declared sinks are replaced by render probes (Set) and a pinned source never
// runs, so neither needs to be here. Everything else is refused, whatever the
// plan declares. Code is excluded: the vm stand-in shares host-realm objects
// ($input, console), so it is not an isolation boundary.
const OFFLINE_SAFE = new Set([...Object.keys(WHITELIST).filter((t) => t !== 'n8n-nodes-base.code'),
  'n8n-nodes-base.summarize', 'n8n-nodes-base.aggregate', 'n8n-nodes-base.dateTime']);

const pinnedNodesOf = (plan) => plan.checkpoints.filter((cp) => cp.node.credential === 'pinned').map((cp) => cp.node);
// Single-fixture (array) mode, unchanged since v3.0: the one pinned source of a
// pinned_node plan, else the trigger.
function pinTargetOf(plan) {
  const pinned = pinnedNodesOf(plan)[0];
  return plan.input?.kind === 'pinned_node' && pinned ? pinned : null;
}

// --- v3.8: render-only sinks (content params only; unknown sink ops fail closed) ---
// paths: content parameter paths whose leaves are rendered; "a.b.*" renders every key under
// a.b (key = the last segment). routing: WHERE the write goes (target tab, row selector),
// rendered under reserved "@" keys in every mode (v3.8.1; Operator @ 885a83c). autoMap:
// content = the input item unchanged. Array leaves render as their exact JSON encoding
// (v3.8.2; a comma-join made ["who,qty"] and ["who","qty"] identical), e.g. ["who"].
const SINK_RENDER = {
  'n8n-nodes-base.slack|message|post': { paths: ['text'] },
  'n8n-nodes-base.gmail|message|send': { paths: ['sendTo', 'subject', 'message'] },
  'n8n-nodes-base.googleCalendar|event|create': { paths: ['start', 'end', 'additionalFields.summary', 'additionalFields.description'] },
  'n8n-nodes-base.googleSheets|sheet|append': { paths: ['columns.value.*'], autoMap: 'columns.mappingMode', routing: { '@sheetName': 'sheetName.value' } },
  'n8n-nodes-base.googleSheets|sheet|update': { paths: ['columns.value.*'], autoMap: 'columns.mappingMode', routing: { '@sheetName': 'sheetName.value', '@matchingColumns': 'columns.matchingColumns' } },
};
const sinkKey = (n) => `${n.type}|${n.parameters?.resource ?? ''}|${n.parameters?.operation ?? ''}`;
const getPath = (o, p) => p.split('.').reduce((a, k) => (a !== null && typeof a === 'object' && own(a, k) ? a[k] : undefined), o);
function renderSpec(node) {
  const spec = SINK_RENDER[sinkKey(node)];
  if (!spec) return null;
  const routing = Object.entries(spec.routing || {}).map(([key, p]) => ({ key, value: getPath(node.parameters, p) ?? '', routing: true }));
  if (spec.autoMap && getPath(node.parameters, spec.autoMap) === 'autoMapInputData') return { autoMap: true, fields: routing };
  const fields = [...routing];
  for (const p of spec.paths) {
    if (p.endsWith('.*')) {
      const base = getPath(node.parameters, p.slice(0, -2));
      if (base && typeof base === 'object') for (const [k, v] of Object.entries(base)) fields.push({ key: k, value: v });
    } else {
      const v = getPath(node.parameters, p);
      if (v !== undefined) fields.push({ key: p.split('.').pop(), value: v });
    }
  }
  return { autoMap: false, fields };
}
function sinkFindings(plan) {
  const findings = [];
  for (const cp of plan.checkpoints.filter((c) => c.node.sideEffect === true)) {
    const spec = renderSpec(cp.node);
    if (!spec) { findings.push(`${cp.id}: sink ${sinkKey(cp.node)} has no render rule (unknown sinks fail closed)`); continue; }
    if (!spec.autoMap && !spec.fields.some((f) => !f.routing)) findings.push(`${cp.id}: sink renders no content`);
    if (spec.fields.some((f) => !f.routing && f.key.startsWith('@'))) findings.push(`${cp.id}: content keys may not start with "@" (reserved for routing)`);
    const keys = spec.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) findings.push(`${cp.id}: sink render keys collide`);
    if (spec.fields.some((f) => f.value !== null && typeof f.value === 'object' && !(Array.isArray(f.value) && f.value.every((x) => x === null || typeof x !== 'object')))) findings.push(`${cp.id}: sink content leaf is not a scalar`);
  }
  return findings;
}

// Verification workflow v3.8: v2 handles the schedule trigger; every declared sink
// becomes a render probe (Set, dot notation OFF so keys stay literal; every value a string,
// or the input item unchanged in autoMap mode).
function verificationWorkflow(workflow, plan) {
  const bare = { ...plan, checkpoints: plan.checkpoints.map((cp) => ({ ...cp, node: { ...cp.node, sideEffect: false } })) };
  const { wf } = v2.verificationWorkflow(workflow, bare);
  for (const cp of plan.checkpoints.filter((c) => c.node.sideEffect === true)) {
    const i = wf.nodes.findIndex((n) => n.name === cp.node.name);
    const spec = renderSpec(cp.node);
    if (i < 0 || !spec) throw new Error(`no render rule for ${cp.node.name}`);
    wf.nodes[i] = { id: wf.nodes[i].id, name: cp.node.name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: wf.nodes[i].position,
      parameters: { includeOtherFields: spec.autoMap, options: { dotNotation: false }, assignments: { assignments: spec.fields.map((f, j) => ({ id: `r${j}`, name: f.key, type: 'string', value: typeof f.value === 'string' ? f.value : Array.isArray(f.value) ? JSON.stringify(f.value) : String(f.value) })) } } };
  }
  return { wf };
}

// --- v3.8: pinned Google reads -----------------------------------------------------
// Shape registry: ONLY from Forge's Aegis-audited cards (pinned-shapes.json next to
// this file). Every pinned node must match a cited entry; its contract must equal the
// cited fields. No registry, or no match, fails closed.
let SHAPES = null;
try { SHAPES = require('./pinned-shapes.json'); } catch { SHAPES = null; }
function setShapeRegistry(reg) { SHAPES = reg; }
const shapeEntries = () => (Array.isArray(SHAPES) ? SHAPES : Array.isArray(SHAPES?.shapes) ? SHAPES.shapes : null);
function shapeFor(node) {
  const entries = shapeEntries();
  if (!entries) return { error: 'no audited pinned-shape registry is loaded' };
  // v3.8.3: `when` is evaluated on the node's parameters RESOLVED WITH n8n DEFAULTS, so an
  // entry pinned to a default (e.g. options.returnFirstMatch=false) matches a plan that omits it.
  const desc = CATALOG[node.type]?.versions?.[String(node.typeVersion)];
  let resolved = node.parameters || {};
  try { if (desc) resolved = NodeHelpers.getNodeParameters(desc.properties, node.parameters || {}, true, false, node, desc) || resolved; } catch { /* keep raw */ }
  // Exact tuple (v3.8.1; Operator @ 885a83c): resource and operation are REQUIRED selectors,
  // never wildcards; types with output-mode params must pin them in `when`.
  const valid = (e) => e && typeof e.type === 'string' && typeof e.resource === 'string' && typeof e.operation === 'string'
    && (OUTPUT_MODE_PARAMS[e.type] || []).every((p) => own(e.when || {}, p));
  const hits = entries.filter((e) => valid(e) && e.type === node.type && String(e.typeVersion) === String(node.typeVersion)
    && e.resource === node.parameters?.resource && e.operation === node.parameters?.operation
    && Object.entries(e.when || {}).every(([p, v]) => { const r = valueWithDefault(desc, resolved, node, p); return r.known && canonV(r.value) === canonV(v); }));
  if (hits.length !== 1) return { error: hits.length ? 'ambiguous pinned-shape registry match' : `no cited output shape for ${node.type}@${node.typeVersion} ${node.parameters?.resource}/${node.parameters?.operation}` };
  const e = hits[0];
  if (e.shape === 'api-passthrough' || !e.fields || typeof e.fields !== 'object' || !Object.keys(e.fields).length) return { error: 'cited shape is api-passthrough/unknown' };
  if (!Array.isArray(e.citations) || !e.citations.length || !e.citations.every((c) => /\S+:\d+/.test(String(c)))) return { error: 'shape entry lacks file:line citations' };
  return { entry: e };
}
// Params that change a read's OUTPUT SHAPE; a registry entry must fix them in `when`.
const OUTPUT_MODE_PARAMS = { 'n8n-nodes-base.gmail': ['simple'] };
// A parameter's value, else its n8n default: top-level from the resolved params; inside a
// collection (e.g. options.returnFirstMatch) n8n does not fill child defaults, so the child's
// declared default is read from the DISPLAYED collection's description.
// v3.8.4 (Operator @ 23c5029): returns {known, value}. A qualifier is KNOWN only if its path
// exists in the displayed schema (exactly one property per segment) or is an own value in the
// params; an unknown path, or a missing value with no declared default, never matches, so
// undefined is never conflated with an explicit null.
function valueWithDefault(desc, resolved, node, p) {
  const segs = p.split('.');
  let cur = resolved;
  let present = true;
  for (const seg of segs) {
    if (cur !== null && typeof cur === 'object' && own(cur, seg)) cur = cur[seg]; else { present = false; break; }
  }
  if (!desc) return present ? { known: true, value: cur } : { known: false };
  const [head, ...rest] = segs;
  const props = desc.properties.filter((x) => x.name === head && NodeHelpers.displayParameter(resolved, x, node, desc));
  if (props.length !== 1) return { known: false };
  let prop = props[0];
  // v3.8.5 (Operator @ ff39f85): every nested child must also be DISPLAYED for this node
  // (version and sibling conditions), evaluated against its parent collection's values with
  // the resolved root params; a hidden child (e.g. returnFirstMatch on Sheets < 4.5) is unknown.
  let parentValues = getPath(resolved, head);
  for (const seg of rest) {
    const kids = (prop.options || []).filter((o) => o && o.name === seg
      && NodeHelpers.displayParameter(parentValues && typeof parentValues === 'object' ? parentValues : {}, o, node, desc, resolved));
    if (kids.length !== 1) return { known: false };
    prop = kids[0];
    parentValues = parentValues && typeof parentValues === 'object' && own(parentValues, seg) ? parentValues[seg] : undefined;
  }
  if (present) return { known: true, value: cur };
  return own(prop, 'default') ? { known: true, value: prop.default } : { known: false };
}
const canonV = (v) => JSON.stringify(v === undefined ? null : v);
const ITEM_DEPENDENT = /\$json|\$input|\$\(|\.item\b|\$item/;
function pinFindings(plan) {
  const findings = [];
  const pinned = plan.checkpoints.filter((cp) => cp.node.credential === 'pinned');
  const keys = pinned.map((cp) => cp.node.pinKey).filter((k) => k !== undefined);
  if (keys.length && (keys.length !== pinned.length || new Set(keys).size !== keys.length || keys.some((k) => typeof k !== 'string' || !k || k === '@trigger'))) {
    findings.push('pinKey: when used, every pinned node needs a unique non-empty pinKey (not "@trigger")');
  }
  for (const cp of pinned) {
    const deps = depsOf(cp);
    const afterTrigger = deps.length === 1 && deps[0] && deps[0].node === '@trigger';
    if (!afterTrigger && !(cp.node.executeOnce === true && !ITEM_DEPENDENT.test(JSON.stringify(cp.node.parameters || {})))) {
      findings.push(`${cp.id}: a pinned read must follow the trigger, or set executeOnce:true with no item-dependent expressions (a pin cannot reproduce per-item reads)`);
    }
    const s = shapeFor(cp.node);
    if (s.error) { findings.push(`${cp.id}: ${s.error} (unknown shapes fail closed)`); continue; }
    // A cited shape is either exact, or fixed fields + user-defined columns (extra: 'sheet-columns',
    // e.g. Sheets rows = row_number + the sheet's header columns).
    for (const c of contractsOf(cp)) {
      const fixedOk = Object.entries(s.entry.fields).every(([k, t]) => own(c.fields || {}, k) && String(c.fields[k]) === String(t));
      if (s.entry.extra === 'sheet-columns' ? !fixedOk : canonFields(c.fields) !== canonFields(s.entry.fields)) findings.push(`${cp.id}: contract fields must ${s.entry.extra ? 'include' : 'equal'} the cited output shape ${canonFields(s.entry.fields)}`);
    }
  }
  return findings;
}
const canonFields = (f) => JSON.stringify(Object.keys(f || {}).sort().map((k) => [k, String(f[k])]));

// Every node of the VERIFICATION workflow must be offline-safe or a pinned source.
function offlineFindings(workflow, plan) {
  let wf;
  try { ({ wf } = verificationWorkflow(workflow, plan)); } catch (e) { return [`verification workflow could not be built (${e.name})`]; }
  const pins = pinnedNodesOf(plan);
  return wf.nodes.filter((n) => !pins.some((p) => n.name === p.name && n.type === p.type) && !OFFLINE_SAFE.has(n.type))
    .map((n) => `${n.name}: type ${n.type} is not offline-safe for E2E scoring (declare it as a sideEffect sink or pinned source, or use an allowlisted node)`);
}

const CATALOG = require('./runtime_node_schemas.json').nodeTypes;
const PKG_FILES = require('n8n-nodes-base/package.json').n8n.nodes;
const TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

const typeOk = (value, spec) => String(spec).split('|').some((t) => (t === 'null' ? value === null
  : t === 'array' ? Array.isArray(value)
    : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : typeof value === t));

const isPort = (p) => Number.isInteger(p) && p >= 0;
// Own-key lookups only: prototype names (toString, constructor, __proto__) never count as declared/produced.
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const ownGet = (o, k) => (own(o, k) ? o[k] : undefined);

// X2-F1 / CRED-PIN-F1: a pinned source or declared sink never executes, so its own
// configuration is checked statically. n8n's issue check (in v2) covers params the
// description marks required; this adds params the description does not mark
// required but CONDITIONALLY shows because of an explicit choice (displayOptions.show
// on a non-@ key, e.g. compare=selectedFields -> fieldsToCompare). A conditionally
// shown scalar left empty is the unfilled payload of that choice. Params declared
// in plan.requiredUserSetup (the user fills them at setup) are exempt.
const EMPTY_CHECK_TYPES = new Set(['string', 'resourceLocator', 'multiOptions', 'number']);
const isEmptyValue = (v) => v === '' || v === undefined || v === null || (Array.isArray(v) && !v.length)
  || (v !== null && typeof v === 'object' && v.__rl === true && (v.value === '' || v.value == null));
// Setup exemptions are NODE-LOCAL: a {param, neededBy:[cp ids]} entry exempts
// that param only on the listed checkpoints (v3.6.1; Operator @ c154d4e found the
// global exemption let one node's declaration silence another node's blank).
function setupFor(plan, cpId) {
  return new Set((plan.requiredUserSetup || []).filter((x) => x && typeof x.param === 'string' && Array.isArray(x.neededBy) && x.neededBy.includes(cpId)).map((x) => x.param));
}
function setupDeclarationFindings(plan) {
  const ids = new Set(plan.checkpoints.map((cp) => cp.id));
  return (plan.requiredUserSetup || []).flatMap((x, i) => {
    if (!x || typeof x !== 'object') return [`requiredUserSetup[${i}]: must be an object`];
    if (x.param === undefined) return [];
    if (typeof x.param !== 'string' || !x.param) return [`requiredUserSetup[${i}]: param must be a non-empty string`];
    if (!Array.isArray(x.neededBy) || !x.neededBy.length || x.neededBy.some((id) => !ids.has(id))) return [`requiredUserSetup[${i}] (${x.param}): neededBy must list existing checkpoint ids`];
    return [];
  });
}
function neverRunConfigFindings(workflow, plan) {
  const findings = [...idFindings(plan), ...setupDeclarationFindings(plan)];
  for (const cp of plan.checkpoints) {
    if (!(cp.node.credential === 'pinned' || cp.node.sideEffect === true)) continue;
    const setup = setupFor(plan, cp.id);
    const n = workflow.nodes.find((x) => x.name === cp.node.name);
    const desc = n && CATALOG[n.type]?.versions?.[String(n.typeVersion)];
    if (!desc) continue; // unknown type/version is already a v1 finding
    // n8n's own required-parameter issues, re-checked with node-local exemptions
    // (v2's check, frozen, exempts globally).
    const issues = Object.keys(NodeHelpers.getNodeParametersIssues(desc.properties, n, desc)?.parameters || {}).filter((p) => !setup.has(p));
    if (issues.length) findings.push(`${n.name}: never-run node has n8n parameter issues outside its own declared user setup: ${issues.join(', ')}`);
    const params = NodeHelpers.getNodeParameters(desc.properties, n.parameters || {}, true, false, n, desc) || {};
    const empty = [...new Set(desc.properties.filter((p) => EMPTY_CHECK_TYPES.has(p.type) && !setup.has(p.name)
      && p.displayOptions?.show && Object.keys(p.displayOptions.show).some((k) => !k.startsWith('@'))
      && NodeHelpers.displayParameter(params, p, n, desc) && isEmptyValue(params[p.name])).map((p) => p.name))];
    if (empty.length) findings.push(`${n.name}: never-run node has empty conditionally-required parameter(s) outside declared user setup: ${empty.join(', ')}`);
  }
  return findings;
}

// v3.7: a checkpoint may depend on several upstream ports (merge inputs):
// dependsOn: {node, port, inputIndex?} | [{node, port, inputIndex}, ...].
const depsOf = (cp) => (Array.isArray(cp.dependsOn) ? cp.dependsOn : [cp.dependsOn]);
// Malformed dependencies never crash assembly: they are wired nowhere here and
// always reported by dependencyFindings (validate), so such a plan is refused.
const wellFormedDep = (d) => d && typeof d === 'object' && typeof d.node === 'string' && isPort(d.port) && (d.inputIndex === undefined || isPort(d.inputIndex));
function assemble(plan) {
  const base = { ...plan, checkpoints: plan.checkpoints.map((cp) => ({ ...cp, dependsOn: wellFormedDep(depsOf(cp)[0]) ? depsOf(cp)[0] : { node: '@trigger', port: 0 } })) };
  const wf = v2.assemble(base);
  const triggerName = wf.nodes[0].name;
  for (const cp of plan.checkpoints) {
    for (const d of depsOf(cp).slice(1).filter(wellFormedDep)) {
      const from = d.node === '@trigger' ? triggerName : d.node;
      wf.connections[from] = wf.connections[from] || { main: [] };
      const ports = wf.connections[from].main;
      while (ports.length <= d.port) ports.push([]);
      ports[d.port].push({ node: cp.node.name, type: 'main', index: d.inputIndex || 0 });
    }
  }
  // v3.8: node-level executeOnce (pinned mid-flow reads) is carried into the workflow.
  for (const cp of plan.checkpoints) {
    if (cp.node.executeOnce !== true) continue;
    const n = wf.nodes.find((x) => x.name === cp.node.name);
    if (n) n.executeOnce = true;
  }
  layout(wf, plan);
  return wf;
}

// v3.8 canvas layout for readability: column = dependency depth, rows spread per
// column in plan order (a branch's outputs land on different rows), no overlaps.
const COL = 260; const ROW = 180;
function layout(wf, plan) {
  const depth = new Map([[wf.nodes[0].name, 0]]);
  for (const cp of plan.checkpoints) {
    const ds = depsOf(cp).filter(wellFormedDep).map((d) => (d.node === '@trigger' ? 0 : depth.get(d.node) ?? 0));
    depth.set(cp.node.name, (ds.length ? Math.max(...ds) : 0) + 1);
  }
  const perCol = new Map();
  for (const n of wf.nodes) { const c = depth.get(n.name) ?? 0; perCol.set(c, [...(perCol.get(c) || []), n]); }
  for (const [c, ns] of perCol) ns.forEach((n, k) => { n.position = [COL * c, Math.round(ROW * (k - (ns.length - 1) / 2))]; });
}

// Readability of the retained canvas: every node name is short and self-describing.
const RESERVED_NAMES = new Set(['__proto__', 'prototype', ...Object.getOwnPropertyNames(Object.prototype)]);
function nameFindings(workflow) {
  return [
    ...workflow.nodes.filter((n) => typeof n.name !== 'string' || !n.name.trim() || n.name.length > 64)
      .map((n) => `${String(n.name).slice(0, 20)}: node name must be 1–64 characters`),
    ...workflow.nodes.filter((n) => typeof n.name === 'string' && RESERVED_NAMES.has(n.name)).map((n) => `${n.name}: reserved node name`),
  ];
}

// Checkpoint ids are identities (setup exemptions, reports): unique non-empty strings.
function idFindings(plan) {
  const seen = new Set();
  const findings = [];
  for (const cp of plan.checkpoints) {
    if (typeof cp.id !== 'string' || !cp.id) findings.push('checkpoint id must be a non-empty string');
    else if (seen.has(cp.id)) findings.push(`${cp.id}: duplicate checkpoint id`);
    seen.add(cp.id);
  }
  return findings;
}

// Output-port arity of the types a verification workflow may run (declared
// sinks run as render probes and pinned sources are single-output reads).
// Anything not listed has exactly one output.
function outputArity(node) {
  if (node.type === 'n8n-nodes-base.if') return 2;
  if (node.type === 'n8n-nodes-base.switch') {
    const p = node.parameters || {};
    if (p.mode === 'expression') return Number.isInteger(p.numberOutputs) ? p.numberOutputs : 4;
    return (Array.isArray(p.rules?.values) ? p.rules.values.length : 0) + (p.options?.fallbackOutput === 'extra' ? 1 : 0);
  }
  return 1;
}

function dependencyFindings(plan) {
  const findings = idFindings(plan);
  const earlier = new Map();
  for (const cp of plan.checkpoints) {
    const deps = depsOf(cp);
    if (!deps.length || deps.some((d) => !d || typeof d !== 'object')) { findings.push(`${cp.id}: dependsOn must be an object or a non-empty array of objects`); earlier.set(cp.node.name, cp.node); continue; }
    for (const d of deps) {
      if (d.node !== '@trigger' && !earlier.has(d.node)) findings.push(`${cp.id}: dependsOn ${JSON.stringify(d.node)} must be @trigger or an EARLIER checkpoint node`);
      const arity = d.node === '@trigger' ? 1 : earlier.has(d.node) ? outputArity(earlier.get(d.node)) : 0;
      if (isPort(d.port) && d.port >= arity) findings.push(`${cp.id}: dependsOn ${JSON.stringify(d.node)} port ${d.port} does not exist (source has ${arity} output(s))`);
      if (!isPort(d.port)) findings.push(`${cp.id}: dependsOn port must be a non-negative integer`);
      if (d.inputIndex !== undefined && !isPort(d.inputIndex)) findings.push(`${cp.id}: dependsOn inputIndex must be a non-negative integer`);
    }
    const idx = deps.map((d) => d.inputIndex || 0).sort((a, b) => a - b);
    if (cp.node.type === 'n8n-nodes-base.merge') {
      const n = Number.isInteger(cp.node.parameters?.numberInputs) ? cp.node.parameters.numberInputs : 2;
      if (idx.join() !== [...Array(n).keys()].join()) findings.push(`${cp.id}: merge needs exactly one dependency per input 0..${n - 1}`);
    } else if (deps.length !== 1 || idx[0] !== 0) {
      findings.push(`${cp.id}: non-merge checkpoint needs exactly one dependency on input 0`);
    }
    earlier.set(cp.node.name, cp.node);
  }
  return findings;
}

// v3.7: contract may be one object or an array of per-port contracts (branch nodes).
const contractsOf = (cp) => (Array.isArray(cp.contract) ? cp.contract : cp.contract ? [cp.contract] : []);

function validate(workflow, plan) {
  // v2 minus its count-assertion rule, which E2E mode replaces with contracts.
  // Removes only the exact finding v1 emits for a checkpoint that truly lacks a
  // count assertion, at most once per checkpoint (never by substring, so a node
  // name containing the phrase cannot suppress other findings).
  const pending = new Map();
  for (const cp of plan.checkpoints) {
    if (!Array.isArray(cp.assertions) || !cp.assertions.some((a) => Number.isInteger(a.count))) {
      const f = `${cp.id}: execution assertions (with count) are required`;
      pending.set(f, (pending.get(f) || 0) + 1);
    }
  }
  const findings = v2.validate(workflow, plan).filter((f) => {
    if (!pending.get(f)) return true;
    pending.set(f, pending.get(f) - 1);
    return false;
  });
  const cpNames = new Set(plan.checkpoints.map((cp) => cp.node.name));
  for (const cp of plan.checkpoints) {
    const cs = contractsOf(cp);
    if (!cs.length) { findings.push(`${cp.id}: E2E mode requires a structural contract {cardinality, fields}`); continue; }
    const ports = cs.map((c) => (c && c.port !== undefined ? c.port : 0));
    if (new Set(ports).size !== ports.length) findings.push(`${cp.id}: at most one contract per output port`);
    for (const c of cs) {
      if (!c || !['items', 'one'].includes(c.cardinality) || !c.fields || typeof c.fields !== 'object' || !Object.keys(c.fields).length) {
        findings.push(`${cp.id}: E2E mode requires a structural contract {cardinality, fields}`);
        continue;
      }
      if (c.port !== undefined && !isPort(c.port)) findings.push(`${cp.id}: contract port must be a non-negative integer`);
      else if ((c.port || 0) >= outputArity(cp.node)) findings.push(`${cp.id}: contract port ${c.port || 0} does not exist (node has ${outputArity(cp.node)} output(s))`);
      for (const [f, spec] of Object.entries(c.fields)) {
        const ts = String(spec).split('|');
        if (!ts.every((t) => TYPES.has(t) || t === 'null' || t === 'absent') || ts.every((t) => t === 'absent')) findings.push(`${cp.id}: contract field ${f} has unsupported type ${spec}`);
      }
    }
  }
  findings.push(...dependencyFindings(plan));
  const bindings = plan.outputBindings;
  if (!bindings || typeof bindings !== 'object' || !Object.keys(bindings).length) findings.push('outputBindings: at least one role binding is required');
  for (const [role, b] of Object.entries(bindings || {})) {
    if (!b || !cpNames.has(b.node)) findings.push(`outputBindings.${role}: must bind a checkpoint node`);
    if (!b || !isPort(b.port)) findings.push(`outputBindings.${role}: port must be a non-negative integer`);
    else if (cpNames.has(b.node) && b.port >= outputArity(plan.checkpoints.find((cp) => cp.node.name === b.node).node)) findings.push(`outputBindings.${role}: port ${b.port} does not exist on ${b.node}`);
  }
  findings.push(...offlineFindings(workflow, plan));
  findings.push(...neverRunConfigFindings(workflow, plan));
  findings.push(...sinkFindings(plan), ...pinFindings(plan), ...nameFindings(workflow));
  return findings;
}

// "absent" in a field spec means the field may be missing (e.g. "string|absent").
function checkContract(items, c) {
  if (c.cardinality === 'one' && items.length !== 1) return [`cardinality one but got ${items.length} items`];
  const specs = Object.entries(c.fields).map(([f, spec]) => [f, String(spec).split('|')]);
  for (const [i, it] of items.entries()) {
    // Undeclared names come from (sealed) data, so only their count is reported.
    const extra = Object.keys(it).filter((k) => !own(c.fields, k));
    if (extra.length) return [`item ${i} has ${extra.length} undeclared field(s)`];
    for (const [f, ts] of specs) {
      if (!own(it, f)) {
        if (!ts.includes('absent')) return [`item ${i} missing field ${f}`];
        continue;
      }
      if (!typeOk(it[f], ts.filter((t) => t !== 'absent').join('|'))) return [`item ${i} field ${f} is not ${ts.join('|')}`];
    }
  }
  return [];
}

// A port the node did not produce is an error, never an empty item list.
function portItems(out, port) {
  if (!out) return { error: 'node not executed' };
  if (!Array.isArray(out.main) || !Array.isArray(out.main[port])) return { error: `node has no output port ${port} (has ${Array.isArray(out.main) ? out.main.length : 0})` };
  return { items: out.main[port] };
}

// Loads only allowlisted types (plus the pinned source's type, which never runs).
function extraTypesFor(workflow, pins) {
  const extra = {};
  for (const n of workflow.nodes) {
    if (WHITELIST[n.type] || !(OFFLINE_SAFE.has(n.type) || pins.some((p) => n.name === p.name && n.type === p.type))) continue;
    const base = n.type.replace('n8n-nodes-base.', '');
    const file = PKG_FILES.find((f) => f.toLowerCase().endsWith(`/${base.toLowerCase()}.node.js`));
    if (file) extra[n.type] = [file, path.basename(file, '.node.js')];
  }
  return extra;
}

// Fixture → pinData. Array (v3.0 mode): the single pinned source of a pinned_node
// plan, else the trigger; more than one pinned node needs the labelled form.
// Object (v3.8): {"<pinKey>": [...], "@trigger"?: [...]}; keys must equal the plan's
// pinKeys (+ "@trigger" if given) exactly, and every pinned node is pinned.
function pinPlan(plan, fixture, triggerName) {
  const pins = plan.checkpoints.filter((cp) => cp.node.credential === 'pinned').map((cp) => cp.node);
  const items = (xs) => xs.map((json) => ({ json }));
  if (Array.isArray(fixture)) {
    if (pins.length > 1) return { error: 'several pinned nodes need labelled fixtures' };
    if (pins.length === 1 && plan.input?.kind !== 'pinned_node') return { error: 'a pinned node with a single fixture needs input.kind pinned_node' };
    const pinData = Object.create(null);
    pinData[pins.length ? pins[0].name : triggerName] = items(fixture);
    return checkedPins(pinData, pins, triggerName);
  }
  if (!fixture || typeof fixture !== 'object') return { error: 'fixture must be an array or a labelled object' };
  const keys = Object.keys(fixture);
  const want = pins.map((p) => p.pinKey);
  if (want.some((k) => typeof k !== 'string' || !k)) return { error: 'every pinned node needs a pinKey for labelled fixtures' };
  const expected = new Set([...want, ...(own(fixture, '@trigger') ? ['@trigger'] : [])]);
  if (keys.length !== expected.size || keys.some((k) => !expected.has(k))) return { error: 'fixture labels do not match the plan pinKeys' };
  if (keys.some((k) => !Array.isArray(fixture[k]))) return { error: 'each labelled fixture must be an array' };
  const pinData = Object.create(null);
  for (const p of pins) pinData[p.name] = items(fixture[p.pinKey]);
  if (own(fixture, '@trigger')) pinData[triggerName] = items(fixture['@trigger']);
  return checkedPins(pinData, pins, triggerName);
}

// Every pinned node (and the trigger, if pinned) must be an OWN key of the pin map; the map
// is copied to a plain object by own keys only (defineProperty), and reserved names are refused.
function checkedPins(pinData, pins, triggerName) {
  const names = pins.map((p) => p.name);
  if ([...names, triggerName].some((n) => RESERVED_NAMES.has(n))) return { error: 'reserved node name in pin set' };
  if (names.some((n) => n === triggerName)) return { error: 'a pinned node may not share the trigger name' };
  if (!names.every((n) => Object.prototype.hasOwnProperty.call(pinData, n))) return { error: 'a pinned node is missing from the pin map' };
  const out = {};
  for (const k of Object.keys(pinData)) Object.defineProperty(out, k, { value: pinData[k], enumerable: true, writable: true, configurable: true });
  return { pinData: out };
}

// Runs the verification workflow with a fixture held by the CALLER (Gauge).
async function execute(workflow, plan, fixture) {
  // Defence in depth: refuse here too, even if a caller skipped validate().
  const unsafe = offlineFindings(workflow, plan);
  if (unsafe.length) throw new Error(`E2E execute refused: ${unsafe.length} node(s) not offline-safe`);
  const { wf } = verificationWorkflow(workflow, plan);
  const triggerName = wf.nodes[0].name;
  const plan_ = pinPlan(plan, fixture, triggerName);
  if (plan_.error) throw new Error(`E2E execute refused: ${plan_.error}`);
  const pins = pinnedNodesOf(plan);
  const pinnedNames = new Set(Object.keys(plan_.pinData));
  const credentialed = pins.filter((p) => (CATALOG[p.type]?.versions?.[String(p.typeVersion)]?.credentials || []).length).map((p) => p.type);
  const run = await executeOffline(wf, { pinData: plan_.pinData, extraTypes: extraTypesFor(wf, pins), allowCredentialedTypes: credentialed });
  // v3.7: in executionOrder v1 a node downstream of a branch port that produced
  // 0 items is never executed. That is a legitimate EMPTY result only when every
  // incoming edge comes from a successful node whose port exists and is empty
  // (or from a node that is itself legitimately empty). Then only port 0 reads as [];
  // anything else not executed stays an error.
  const incoming = {};
  for (const [from, c] of Object.entries(wf.connections || {})) {
    (c.main || []).forEach((edges, port) => (edges || []).forEach((e) => { (incoming[e.node] = incoming[e.node] || []).push({ from, port }); }));
  }
  const emptyMemo = new Map();
  const legitEmpty = (name) => {
    if (emptyMemo.has(name)) return emptyMemo.get(name);
    emptyMemo.set(name, false); // cycles are never empty
    const ins = own(incoming, name) ? incoming[name] : [];
    const ok = ins.length > 0 && ins.every(({ from, port }) => {
      const o = ownGet(run.outputs, from);
      if (!o) return port === 0 && legitEmpty(from); // an un-executed node only ever yields port 0 (as [])
      return o.executionStatus === 'success' && Array.isArray(o.main) && Array.isArray(o.main[port]) && o.main[port].length === 0;
    });
    emptyMemo.set(name, ok);
    return ok;
  };
  const itemsAt = (name, port) => {
    const out = ownGet(run.outputs, name);
    if (!out) return legitEmpty(name) && port === 0 ? { items: [], emptyBranch: true } : { error: 'node not executed' };
    // Engine error messages can quote item values from the sealed fixture: never reported.
    if (out.executionStatus !== 'success') return { error: `node ${out.executionStatus} (engine message withheld)` };
    return portItems(out, port);
  };
  const contracts = plan.checkpoints.flatMap((cp) => contractsOf(cp).map((c) => {
    const id = contractsOf(cp).length > 1 ? `${cp.id}@${c.port || 0}` : cp.id;
    const p = itemsAt(cp.node.name, c.port || 0);
    if (p.error) return { id, pass: false, errors: [p.error] };
    const errors = checkContract(p.items, c);
    return { id, pass: errors.length === 0, errors, ...(p.emptyBranch ? { emptyBranch: true } : {}) };
  }));
  const roleItems = Object.create(null);
  const bindingErrors = [];
  for (const [role, b] of Object.entries(plan.outputBindings)) {
    const p = itemsAt(b.node, b.port);
    if (p.error) bindingErrors.push(`${role}: ${p.error}`);
    else roleItems[role] = p.items;
  }
  const executedSinks = run.executedNodes.filter((e) => plan.checkpoints.some((cp) => cp.node.sideEffect && cp.node.name === e.node && e.type !== 'n8n-nodes-base.set')).length;
  const unsafeExecuted = run.executedNodes.filter((e) => !OFFLINE_SAFE.has(e.type) && !pinnedNames.has(e.node)).length
    + run.executedNodes.filter((e) => pins.some((p) => p.name === e.node)).length; // a pinned node must never execute
  return { status: run.status, contracts, roleItems, bindingErrors, credentialLookups: run.credentialLookups.length, executedSinks, unsafeExecuted };
}

module.exports = { validate, execute, checkContract, assemble, OFFLINE_SAFE, offlineFindings, neverRunConfigFindings, dependencyFindings, verificationWorkflow, setShapeRegistry, SINK_RENDER, pinPlan };
