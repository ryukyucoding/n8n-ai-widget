'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { twitchStatusWorkflow } = require('./runTwitchStatusCompilerSmoke');

function schemas() {
  const descriptor = { properties: [] };
  return Object.fromEntries(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.if'].map((type) => [type, { versions: { '4.4': descriptor } }]));
}

test('compiles the Easy-100 Twitch status example as a read-only conditional workflow', () => {
  const workflow = twitchStatusWorkflow({ nodeTypes: schemas() });
  assert.equal(workflow.active, false);
  assert.equal(workflow.nodes.length, 6);
  assert.equal(workflow.nodes[2].parameters.method, 'POST');
  assert.equal(workflow.nodes[3].type, 'n8n-nodes-base.if');
  assert.equal(workflow.connections['Step 4: is live'].main.length, 2);
  assert.deepEqual(workflow.nodes.slice(4).map((node) => node.parameters.assignments.assignments.find((item) => item.name === 'isLive').value), [true, false]);
});
