'use strict';

const test = require('node:test');
const assert = require('node:assert');
const route = require('../src/directRoute/route2');

const step = (name, type, typeVersion, parameters, extra = {}) => ({ name, type, typeVersion, parameters, ...extra });
const setNode = (name, assignments) => step(name, 'n8n-nodes-base.set', 3.4, { includeOtherFields: false, options: {},
  assignments: { assignments: assignments.map(([n, t, v], i) => ({ id: `a${i}`, name: n, type: t, value: v })) } });
const clone = (v) => JSON.parse(JSON.stringify(v));

const schedulePlan = {
  task: 'ctl-schedule', settings: { executionOrder: 'v1', timezone: 'Europe/Berlin' },
  input: { kind: 'schedule' },
  trigger: { name: 'Weekdays 08:00', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2,
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } }, expectCron: '0 8 * * 1-5' },
  checkpoints: [{ id: 'CP1', dependsOn: { node: 'Weekdays 08:00', port: 0 }, node: setNode('CP1 Echo', [['a', 'number', '={{ $json.a }}']]),
    assertions: [{ port: 0, count: 1, items: [{ a: 1 }] }] }],
  outputBindings: { out: { node: 'CP1 Echo', port: 0 } },
};
const pinnedPlan = {
  task: 'ctl-pinned', settings: { executionOrder: 'v1' }, input: { kind: 'pinned_node' },
  requiredUserSetup: [{ kind: 'resource', param: 'documentId' }],
  checkpoints: [
    { id: 'CP0', dependsOn: { node: '@trigger', port: 0 }, node: step('CP0 Read Sheet', 'n8n-nodes-base.googleSheets', 4.7,
      { resource: 'sheet', operation: 'read', documentId: { __rl: true, mode: 'id', value: '' }, sheetName: { __rl: true, mode: 'name', value: 'Leads' }, options: {} }, { credential: 'pinned' }),
      assertions: [{ port: 0, count: 2 }] },
    { id: 'CP1', dependsOn: { node: 'CP0 Read Sheet', port: 0 }, node: setNode('CP1 Name', [['name', 'string', '={{ $json.name }}']]),
      assertions: [{ port: 0, count: 2, items: [{ name: 'Ivy' }, { name: 'Kai' }] }] },
  ],
  outputBindings: { out: { node: 'CP1 Name', port: 0 } },
};
const sinkPlan = {
  task: 'ctl-sink', settings: { executionOrder: 'v1' }, input: { kind: 'trigger_items' },
  checkpoints: [
    { id: 'CP1', dependsOn: { node: '@trigger', port: 0 }, node: setNode('CP1 Compose', [['text', 'string', '={{ "Hot lead: " + $json.company }}']]),
      assertions: [{ port: 0, count: 2 }] },
    { id: 'CP2', dependsOn: { node: 'CP1 Compose', port: 0 }, node: step('CP2 Post To Slack', 'n8n-nodes-base.slack', 2.4,
      { resource: 'message', operation: 'post', select: 'channel', channelId: { __rl: true, mode: 'name', value: '#sales' }, text: '={{ $json.text }}', otherOptions: {} }, { sideEffect: true }),
      assertions: [{ port: 0, count: 2, items: [{ text: 'Hot lead: Acme' }, { text: 'Hot lead: Globex' }] }] },
  ],
  outputBindings: { messages: { node: 'CP2 Post To Slack', port: 0 } },
};

async function runPositive(label, plan, fixture, extraCheck) {
  const wf = route.assemble(plan);
  const findings = route.validate(wf, plan);
  if (findings.length) return { label, pass: false, why: findings };
  const ex = await route.execute(wf, plan, fixture);
  const ok = ex.checkpoints.every((c) => c.pass) && extraCheck(ex);
  return { label, pass: ok, why: ok ? null : { checkpoints: ex.checkpoints, lookups: ex.credentialLookups, sinks: ex.executedSinks } };
}
function negative(label, plan, mutate, expect) {
  const p = clone(plan); mutate(p);
  const f = route.validate(route.assemble(p), p);
  const hit = f.find((x) => x.includes(expect));
  return { label, pass: Boolean(hit), why: hit || f };
}

test('V2 Controls Suite (13/13)', async (t) => {
  const results = [
    await runPositive('schedule: valid cron + IANA timezone passes; manual substitute executes', schedulePlan, [{ a: 1 }], () => true),
    negative('schedule: wrong cron', schedulePlan, (p) => { p.trigger.parameters.rule.interval[0].expression = '0 9 * * 1-5'; }, 'cron'),
    negative('schedule: missing timezone', schedulePlan, (p) => { delete p.settings.timezone; }, 'settings.timezone must be a valid IANA zone'),
    negative('schedule: invalid timezone', schedulePlan, (p) => { p.settings.timezone = 'Mars/Base'; }, 'settings.timezone must be a valid IANA zone'),
    await runPositive('pinned source: no credentials, pinned, never executed, 0 lookups', pinnedPlan, [{ name: 'Ivy' }, { name: 'Kai' }], (ex) => ex.credentialLookups === 0 && ex.pinTarget === 'CP0 Read Sheet'),
    negative('pinned source: credentials attached', pinnedPlan, (p) => { p.checkpoints[0].node.credentials = { googleSheetsOAuth2Api: { id: 'x', name: 'x' } }; }, 'credentials present'),
    negative('pinned source: undeclared user-setup param', pinnedPlan, (p) => { p.requiredUserSetup = []; }, 'n8n parameter issues outside declared user setup'),
    negative('credentialed node without pinned/sideEffect declaration', pinnedPlan, (p) => { delete p.checkpoints[0].node.credential; }, 'requires credentials'),
    await runPositive('sink: never executed; rendered text per item', sinkPlan, [{ company: 'Acme' }, { company: 'Globex' }], (ex) => ex.executedSinks === 0),
    negative('sink: credentials attached', sinkPlan, (p) => { p.checkpoints[1].node.credentials = { slackApi: { id: 'x', name: 'x' } }; }, 'credentials present'),
    negative('sink: waiting operation (sendAndWait) rejected', sinkPlan, (p) => { p.checkpoints[1].node.parameters.operation = 'sendAndWait'; }, 'waiting/listening operations are not allowed'),
    negative('real trigger type stays blocked even if declared', sinkPlan, (p) => { Object.assign(p.checkpoints[1].node, { type: 'n8n-nodes-base.slackTrigger', typeVersion: 1, parameters: {} }); }, 'listener/trigger'),
    negative('sink: undeclared (no sideEffect flag)', sinkPlan, (p) => { delete p.checkpoints[1].node.sideEffect; }, 'requires credentials'),
  ];

  for (const r of results) {
    assert.strictEqual(r.pass, true, `Control failed: ${r.label} - why: ${JSON.stringify(r.why)}`);
  }
  const passCount = results.filter((r) => r.pass).length;
  assert.strictEqual(passCount, 13, `Expected 13/13 passing controls, got ${passCount}`);
  console.log(`V2_CONTROLS ${passCount}/${results.length} PASS`);
  process.exit(0);
});
