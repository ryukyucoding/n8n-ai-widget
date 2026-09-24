'use strict';

// Demo 4 / E2E-G runtime packet library (no runtime calls). Generalises the Demo 3
// packet to labelled multi-pin fixtures and Google render-only sinks.
// Per task it emits TWO payloads:
//   real   : the workflow for Dan's canvas (retained). Runtime test pins EVERY Google
//            node (pinned sources AND sinks), so nothing reads, sends or writes.
//            Non-sink roles are compared on their own nodes.
//   render : the v3.8 verification twin (each sink replaced by its render probe; sources
//            pinned). A runtime test of it shows n8n itself rendering the sink content;
//            sink roles are compared there. brain decides whether the twin is kept.
// Every expected output comes from the offline engine AND must equal an independent
// plain-JS oracle written from the public request text.

const route = require('./route3');

const copy = (v) => JSON.parse(JSON.stringify(v));
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a, b, ordered) => Array.isArray(a) && Array.isArray(b) && (ordered ? canon(a) === canon(b) : canon(a.map(canon).sort()) === canon(b.map(canon).sort()));

// fixture: array (single injection) or {"<pinKey>"|"@trigger": [...]}; oracle(fixture) -> {role: items}.
async function buildTask(id, plan, fixture, oracle, ordered, opts = {}) {
  const workflow = route.assemble(plan);
  const findings = route.validate(workflow, plan);
  if (findings.length) throw new Error(`${id} validator: ${findings.join('; ')}`);
  const ex = await route.execute(copy(workflow), plan, copy(fixture));
  if (!ex.contracts.every((c) => c.pass) || ex.bindingErrors.length || ex.executedSinks || ex.unsafeExecuted || ex.credentialLookups) {
    throw new Error(`${id} offline run not clean: ${JSON.stringify({ c: ex.contracts, b: ex.bindingErrors, s: ex.executedSinks, u: ex.unsafeExecuted, l: ex.credentialLookups })}`);
  }
  const want = oracle(copy(fixture));
  for (const role of Object.keys(plan.outputBindings)) {
    if (!Object.prototype.hasOwnProperty.call(want, role)) throw new Error(`${id}: oracle has no role ${role}`);
    if (!same(ex.roleItems[role], want[role], ordered[role] ?? false)) throw new Error(`${id}.${role} engine disagrees with the independent oracle: ${canon(ex.roleItems[role])} vs ${canon(want[role])}`);
  }
  const triggerName = workflow.nodes[0].name;
  const pp = route.pinPlan(plan, copy(fixture), triggerName);
  if (pp.error) throw new Error(`${id} pin plan: ${pp.error}`);
  const sinks = plan.checkpoints.filter((c) => c.node.sideEffect === true).map((c) => c.node.name);
  const realPins = { ...pp.pinData };
  for (const s of sinks) realPins[s] = [{ json: { pinnedSinkNotExecuted: true } }];
  const { wf: twin } = route.verificationWorkflow(copy(workflow), plan);
  const roles = Object.fromEntries(Object.entries(plan.outputBindings).map(([role, b]) => [role, {
    node: b.node, port: b.port, ordered: ordered[role] ?? false, items: ex.roleItems[role],
    compareIn: sinks.includes(b.node) ? 'render' : 'real',
  }]));
  const name = opts.namePrefix || 'KEYSTONE-DEMO4';
  const real = { ...copy(workflow), name: `${name}-${id}`, settings: { ...workflow.settings, availableInMCP: true } };
  const render = { ...copy(twin), name: `${name}-${id}-RENDER-CHECK (render-only, non-production)`, settings: { ...twin.settings, availableInMCP: true } };
  // Canvas notes (brain 2026-09-24): twins are retained as verification evidence, explicitly
  // render-only / non-production, and linked to their real workflow by name.
  const note = (nodeId, content) => ({ id: nodeId, name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, -320], parameters: { content, width: 520, height: 180 } });
  real.nodes.push(note('note-real', `## ${real.name}
The workflow to use. Google nodes need your own credentials and setup (see the setup list).
Render check twin: **${render.name}**`));
  render.nodes.push(note('note-render', `## RENDER-ONLY, NON-PRODUCTION
Verification evidence for **${real.name}**. Every Google write was replaced by a Set probe that only shows what would be sent or written. Never activate this workflow.`));
  for (const p of [real, render]) if (JSON.stringify(p).includes('"credentials"')) throw new Error(`${id} payload mentions credentials`);
  // A render twin must contain no Google or Slack node except pinned sources.
  const pinnedNames = new Set(Object.keys(pp.pinData));
  if (render.nodes.some((n) => /googleSheets|gmail|googleCalendar|googleDrive|slack/.test(n.type) && !pinnedNames.has(n.name))) throw new Error(`${id}: render twin still has an unpinned app node`);
  return {
    createPayloads: { real, render },
    mcp: {
      real: { tool: 'test_workflow', args: { pinData: realPins, triggerNodeName: triggerName } },
      render: { tool: 'test_workflow', args: { pinData: pp.pinData, triggerNodeName: twin.nodes[0].name } },
    },
    pinnedInReal: Object.keys(realPins), sinks,
    userSetupDeclaredNotFilled: (plan.requiredUserSetup || []).filter((x) => x.param).map((x) => ({ param: x.param, neededBy: x.neededBy })),
    expected: { roles },
    layout: real.nodes.map((n) => ({ name: n.name, position: n.position })),
  };
}

module.exports = { buildTask, same, canon };
