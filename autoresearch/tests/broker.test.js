'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBrokerServer } = require('../broker/server');
const { requestPathFromArgs, readRequest, sendRequest } = require('../client/task-client');
const { request: debuggerInboxRequest } = require('../client/debugger-inbox');
const { parseArgs, readReply } = require('../client/reply-task');
const { agentIdFromEnvironment, request: taskStatusRequest } = require('../client/task-status');
const { request: agentInboxRequest } = require('../client/agent-inbox');
const { completionRequest } = require('../client/complete-task');

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

test('scoped tokens prevent impersonation and can be revoked independently', async () => {
  const broker = await startBroker({ agentTokens: new Map([
    ['orchestrator-token', 'orchestrator'],
    ['lab-token', 'experiment-engineer'],
  ]) });
  try {
    const created = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'experiment-engineer',
      taskType: 'offline_plan', state: 'submitted', text: 'Prepare an offline plan.',
    }), { authorization: 'Bearer orchestrator-token' });
    assert.equal(created.body.result.ownerAgentId, 'orchestrator');

    const impersonation = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'experiment-engineer',
      taskType: 'offline_plan', state: 'submitted', text: 'Pretend to be the orchestrator.',
    }), { authorization: 'Bearer lab-token' });
    assert.equal(impersonation.body.error.code, -32001);

    const deniedAfterRevocation = await rpc(broker.url, sendMessage({
      senderAgentId: 'experiment-engineer', assigneeAgentId: 'experiment-engineer',
      taskType: 'offline_plan', state: 'submitted', text: 'This token no longer exists.',
    }), { authorization: 'Bearer removed-lab-token' });
    assert.equal(deniedAfterRevocation.status, 401);
  } finally { await broker.close(); }
});

test('task status returns a safe summary and scopes visibility to the caller', async () => {
  const broker = await startBroker({ agentTokens: new Map([
    ['orchestrator-token', 'orchestrator'],
    ['lab-token', 'experiment-engineer'],
    ['research-token', 'evidence-researcher'],
  ]) });
  try {
    const created = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'experiment-engineer',
      taskType: 'offline_plan', state: 'submitted', text: 'Do not expose this instruction.',
      artifactRefs: [{ repository: 'n8n-ai-widget', revision: 'a'.repeat(40), path: 'autoresearch/result.json', sha256: 'b'.repeat(64), summary: 'Safe output.' }],
    }), { authorization: 'Bearer orchestrator-token' });
    const status = await rpc(broker.url, taskStatusRequest('experiment-engineer'), { authorization: 'Bearer lab-token' });
    assert.equal(status.body.result.length, 1);
    assert.deepEqual(Object.keys(status.body.result[0]).sort(), [
      'assigneeAgentId', 'createdAt', 'executionHost', 'hasArtifactRefs', 'id', 'messageCount',
      'ownerAgentId', 'resourceClass', 'state', 'taskType', 'updatedAt',
    ]);
    assert.equal(JSON.stringify(status.body.result).includes('Do not expose this instruction.'), false);
    assert.equal(JSON.stringify(status.body.result).includes('autoresearch/result.json'), false);

    const hidden = await rpc(broker.url, taskStatusRequest('evidence-researcher'), { authorization: 'Bearer research-token' });
    assert.equal(hidden.body.result.length, 0);
    assert.equal(created.body.result.id, status.body.result[0].id);
  } finally { await broker.close(); }
});

test('task-status client validates its environment-only role selector', () => {
  assert.equal(agentIdFromEnvironment({ A2A_AGENT_ID: 'experiment-engineer' }), 'experiment-engineer');
  assert.equal(agentIdFromEnvironment({}), undefined);
  assert.throws(() => agentIdFromEnvironment({ A2A_AGENT_ID: 'not-a-role' }), /allowlisted/);
});

test('a scoped experiment engineer can read and complete only its assigned task', async () => {
  const broker = await startBroker({ agentTokens: new Map([
    ['orchestrator-token', 'orchestrator'],
    ['lab-token', 'experiment-engineer'],
  ]) });
  try {
    const created = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'experiment-engineer',
      executionHost: 'workstation-b', resourceClass: 'light', taskType: 'c07_fixture_manifest_check',
      state: 'submitted', text: 'Inspect the declared C07 fixture fields without running n8n.',
    }), { authorization: 'Bearer orchestrator-token' });
    const inbox = await rpc(broker.url, agentInboxRequest('experiment-engineer'), { authorization: 'Bearer lab-token' });
    assert.equal(inbox.body.result.length, 1);
    assert.equal(inbox.body.result[0].id, created.body.result.id);

    const completed = await rpc(broker.url, completionRequest(created.body.result, 'experiment-engineer', 'Required fixture fields are present; no n8n operation was performed.'), { authorization: 'Bearer lab-token' });
    assert.equal(completed.body.result.state, 'completed');
    assert.equal(completed.body.result.messages.at(-1).senderAgentId, 'experiment-engineer');
    assert.throws(() => completionRequest(created.body.result, 'debugger', 'Not assigned.'), /assigned/);
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

test('client reads a safe JSON-RPC request and sends it without argv credentials', async () => {
  const broker = await startBroker({ token: 'client-token' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-client-'));
  const requestPath = path.join(directory, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(sendMessage({
    senderAgentId: 'orchestrator', assigneeAgentId: 'debugger', executionHost: 'server',
    resourceClass: 'light', taskType: 'diagnosis', text: 'Inspect a sanitized failure packet.', state: 'submitted',
  })));
  try {
    assert.equal(requestPathFromArgs(['--request', requestPath]), requestPath);
    assert.throws(() => requestPathFromArgs(['--token', 'not-allowed']), /Usage/);
    const response = await sendRequest({ endpoint: broker.url, token: 'client-token', request: readRequest(requestPath) });
    assert.equal(response.result.assigneeAgentId, 'debugger');
  } finally { await broker.close(); }
});

test('debugger can read only submitted inbox tasks and submit a file-backed reply', async () => {
  const broker = await startBroker();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-reply-'));
  const replyPath = path.join(directory, 'reply.txt');
  fs.writeFileSync(replyPath, 'Add a regression test before any implementation change.');
  try {
    const created = await rpc(broker.url, sendMessage({
      senderAgentId: 'orchestrator', assigneeAgentId: 'debugger', executionHost: 'server',
      resourceClass: 'light', taskType: 'sanitized_failure_diagnosis', text: 'Inspect the safe failure packet.', state: 'submitted',
    }));
    const inbox = await rpc(broker.url, debuggerInboxRequest());
    assert.equal(inbox.body.result.length, 1);
    assert.equal(inbox.body.result[0].id, created.body.result.id);
    assert.deepEqual(parseArgs(['--task', created.body.result.id, '--reply', replyPath]), { taskId: created.body.result.id, replyPath });
    assert.equal(readReply(replyPath), 'Add a regression test before any implementation change.');
  } finally { await broker.close(); }
});
