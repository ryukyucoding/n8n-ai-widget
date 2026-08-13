'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBrokerServer } = require('../broker/server');

async function startBroker(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-a2a-'));
  const server = createBrokerServer({ statePath: path.join(directory, 'tasks.json'), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => new Promise((resolve) => server.close(resolve)),
  };
}

async function rpc(url, request, headers = {}) {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(request),
  });
  return { status: response.status, body: await response.json() };
}

function sendMessage(params) {
  return { jsonrpc: '2.0', id: 'test-1', method: 'SendMessage', params };
}

test('serves A2A-shaped facilitator and role cards', async () => {
  const broker = await startBroker();
  try {
    const card = await fetch(`${broker.url}/.well-known/agent-card.json`).then((response) => response.json());
    const role = await fetch(`${broker.url}/agents/debugger/.well-known/agent-card.json`).then((response) => response.json());
    assert.equal(card.name, 'AutoResearch A2A Task Broker');
    assert.equal(role.name, 'debugger AutoResearch role');
  } finally { await broker.close(); }
});

test('creates a durable task and permits the assignee to complete it', async () => {
  const broker = await startBroker();
  try {
    const created = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'experiment-engineer',
      taskType: 'offline_plan', state: 'submitted', text: 'Prepare a no-network test plan.',
    }));
    assert.equal(created.status, 200);
    assert.equal(created.body.result.state, 'submitted');
    const taskId = created.body.result.id;
    const completed = await rpc(broker.url, sendMessage({
      taskId, senderAgentId: 'experiment-engineer', assigneeAgentId: 'experiment-engineer',
      taskType: 'offline_plan', state: 'completed', text: 'Plan completed; no external calls were made.',
    }));
    assert.equal(completed.body.result.state, 'completed');
    assert.equal(completed.body.result.messages.length, 2);
  } finally { await broker.close(); }
});

test('rejects unsafe content and unapproved task updates', async () => {
  const broker = await startBroker();
  try {
    const unsafe = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'debugger', taskType: 'diagnosis',
      text: 'Authorization: Bearer not-a-real-secret', state: 'submitted',
    }));
    assert.equal(unsafe.body.error.code, -32602);

    const created = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'debugger', taskType: 'diagnosis',
      text: 'Review the sanitized failure summary.', state: 'submitted',
    }));
    const denied = await rpc(broker.url, sendMessage({
      taskId: created.body.result.id, senderAgentId: 'evidence-researcher', assigneeAgentId: 'debugger',
      taskType: 'diagnosis', text: 'I should not update this task.', state: 'working',
    }));
    assert.equal(denied.body.error.code, -32602);
  } finally { await broker.close(); }
});

test('requires a token when configured', async () => {
  const broker = await startBroker({ token: 'local-test-token' });
  try {
    const missing = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'debugger', taskType: 'diagnosis', text: 'Review.', state: 'submitted',
    }));
    assert.equal(missing.status, 401);
    const allowed = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'debugger', taskType: 'diagnosis', text: 'Review.', state: 'submitted',
    }), { authorization: 'Bearer local-test-token' });
    assert.equal(allowed.body.result.assigneeAgentId, 'debugger');
  } finally { await broker.close(); }
});

test('permits only one active model inference task per host', async () => {
  const broker = await startBroker();
  try {
    const create = (text) => rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'experiment-engineer',
      executionHost: 'workstation-b', resourceClass: 'model-inference',
      taskType: 'approved_generation', text, state: 'submitted',
    }));
    const first = await create('Prepare the first approved generation task.');
    const second = await create('Prepare the second approved generation task.');
    const started = await rpc(broker.url, sendMessage({
      taskId: first.body.result.id, senderAgentId: 'experiment-engineer', assigneeAgentId: 'experiment-engineer',
      executionHost: 'workstation-b', resourceClass: 'model-inference',
      taskType: 'approved_generation', text: 'Starting the first task.', state: 'working',
    }));
    assert.equal(started.body.result.state, 'working');
    const blocked = await rpc(broker.url, sendMessage({
      taskId: second.body.result.id, senderAgentId: 'experiment-engineer', assigneeAgentId: 'experiment-engineer',
      executionHost: 'workstation-b', resourceClass: 'model-inference',
      taskType: 'approved_generation', text: 'Starting the second task.', state: 'working',
    }));
    assert.equal(blocked.body.error.code, -32009);
  } finally { await broker.close(); }
});
