'use strict';

const http = require('node:http');
const path = require('node:path');
const { TaskStore } = require('./store');
const { AGENT_IDS, normalizeMessageParams, createTask, appendMessage, assertCapacity, listInbox, publicTask, protocolError } = require('./protocol');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

function agentCard(agentId) {
  return {
    protocolVersion: '1.0',
    name: `${agentId} AutoResearch role`,
    description: 'Internal, human-supervised AutoResearch task handoff role.',
    url: `/rpc`,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ id: 'research-task-handoff', name: 'Research task handoff' }],
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    security: [{ bearerAuth: [] }],
  };
}

function facilitatorCard() {
  return {
    protocolVersion: '1.0',
    name: 'AutoResearch A2A Task Broker',
    description: 'A local, human-supervised task handoff broker. Not a model agent.',
    url: '/rpc',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ id: 'task-handoff', name: 'Durable task and evidence handoff' }],
  };
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32_000) reject(protocolError('request body is too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(protocolError('request body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function parseAgentTokens(value) {
  if (!value) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('A2A_BROKER_AGENT_TOKENS_JSON must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('A2A_BROKER_AGENT_TOKENS_JSON must be a JSON object');
  }
  const tokens = new Map();
  for (const [agentId, agentToken] of Object.entries(parsed)) {
    if (!AGENT_IDS.has(agentId) || typeof agentToken !== 'string' || !agentToken.trim()) {
      throw new Error('A2A_BROKER_AGENT_TOKENS_JSON contains an invalid agent token entry');
    }
    if (tokens.has(agentToken)) throw new Error('A2A_BROKER_AGENT_TOKENS_JSON tokens must be unique');
    tokens.set(agentToken, agentId);
  }
  return tokens;
}

function authenticate(req, { token, agentTokens }) {
  const authorization = req.headers.authorization;
  if (!token && agentTokens.size === 0) return { mode: 'unconfigured' };
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const presentedToken = authorization.slice('Bearer '.length);
  const agentId = agentTokens.get(presentedToken);
  if (agentId) return { mode: 'scoped', agentId };
  if (token && presentedToken === token) return { mode: 'legacy' };
  return null;
}

function assertScopedSender(principal, senderAgentId) {
  if (principal.mode === 'scoped' && principal.agentId !== senderAgentId) {
    throw protocolError('scoped agent identity cannot send as another agent', -32001);
  }
}

function assertTaskAccess(principal, task) {
  if (principal.mode !== 'scoped' || principal.agentId === 'orchestrator') return;
  if (task.ownerAgentId !== principal.agentId && task.assigneeAgentId !== principal.agentId) {
    throw protocolError('scoped agent identity cannot access this task', -32001);
  }
}

function taskSummary(task) {
  return {
    id: task.id,
    ownerAgentId: task.ownerAgentId,
    assigneeAgentId: task.assigneeAgentId,
    taskType: task.taskType,
    executionHost: task.executionHost,
    resourceClass: task.resourceClass,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    messageCount: task.messages.length,
    hasArtifactRefs: task.messages.some((message) => message.artifactRefs.length > 0),
  };
}

function createBrokerServer({
  statePath,
  token = process.env.A2A_BROKER_TOKEN,
  agentTokens = parseAgentTokens(process.env.A2A_BROKER_AGENT_TOKENS_JSON),
  now = () => new Date().toISOString(),
} = {}) {
  const store = new TaskStore(statePath || process.env.A2A_BROKER_STATE_PATH || path.join(ROOT, 'state', 'tasks.json'));
  store.load();
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') return json(res, 200, facilitatorCard());
    const cardMatch = req.method === 'GET' && req.url.match(/^\/agents\/([a-z-]+)\/\.well-known\/agent-card\.json$/);
    if (cardMatch) return json(res, 200, agentCard(cardMatch[1]));
    if (req.method !== 'POST' || req.url !== '/rpc') return json(res, 404, { error: 'not_found' });
    const principal = authenticate(req, { token, agentTokens });
    if (!principal) return json(res, 401, { error: 'unauthorized' });

    let rpcId = null;
    try {
      const request = await readJson(req);
      rpcId = request.id ?? null;
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw protocolError('invalid JSON-RPC request');
      if (request.method === 'SendMessage') {
        const message = normalizeMessageParams(request.params);
        assertScopedSender(principal, message.senderAgentId);
        const task = message.taskId ? store.get(message.taskId) : null;
        if (task) assertTaskAccess(principal, task);
        assertCapacity([...store.tasks.values()], task && task.id, message);
        const result = task
          ? store.update(appendMessage(task, message, now()))
          : store.create(createTask(message, now()));
        return json(res, 200, { jsonrpc: '2.0', id: rpcId, result: publicTask(result) });
      }
      if (request.method === 'GetTask') {
        const taskId = request.params && request.params.taskId;
        const task = typeof taskId === 'string' ? store.get(taskId) : null;
        if (!task) throw protocolError('task was not found', -32004);
        assertTaskAccess(principal, task);
        return json(res, 200, { jsonrpc: '2.0', id: rpcId, result: publicTask(task) });
      }
      if (request.method === 'ListInbox') {
        const agentId = request.params && request.params.agentId;
        if (principal.mode === 'scoped' && principal.agentId !== agentId) {
          throw protocolError('scoped agent identity cannot read another inbox', -32001);
        }
        const result = listInbox([...store.tasks.values()], agentId).map(publicTask);
        return json(res, 200, { jsonrpc: '2.0', id: rpcId, result });
      }
      if (request.method === 'ListTaskSummaries') {
        const requestedAgentId = request.params && request.params.agentId;
        const tasks = [...store.tasks.values()].filter((task) => {
          if (principal.mode === 'scoped' && principal.agentId !== 'orchestrator') {
            return task.ownerAgentId === principal.agentId || task.assigneeAgentId === principal.agentId;
          }
          if (typeof requestedAgentId === 'string') {
            return task.ownerAgentId === requestedAgentId || task.assigneeAgentId === requestedAgentId;
          }
          return true;
        });
        return json(res, 200, { jsonrpc: '2.0', id: rpcId, result: tasks.map(taskSummary) });
      }
      throw protocolError('method is not supported', -32601);
    } catch (error) {
      return json(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: error.code || -32603, message: error.message || 'internal error' },
      });
    }
  });
}

if (require.main === module) {
  const host = process.env.A2A_BROKER_HOST || DEFAULT_HOST;
  const token = process.env.A2A_BROKER_TOKEN;
  const agentTokens = parseAgentTokens(process.env.A2A_BROKER_AGENT_TOKENS_JSON);
  if (host !== DEFAULT_HOST && !token && agentTokens.size === 0) {
    throw new Error('A2A_BROKER_TOKEN or A2A_BROKER_AGENT_TOKENS_JSON is required when A2A_BROKER_HOST is not 127.0.0.1');
  }
  const port = Number(process.env.A2A_BROKER_PORT || DEFAULT_PORT);
  createBrokerServer({ token, agentTokens }).listen(port, host, () => {
    process.stdout.write(`AutoResearch A2A task broker listening on http://${host}:${port}\n`);
  });
}

module.exports = { createBrokerServer, facilitatorCard, agentCard, parseAgentTokens, taskSummary };
