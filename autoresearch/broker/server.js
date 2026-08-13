'use strict';

const http = require('node:http');
const path = require('node:path');
const { TaskStore } = require('./store');
const { normalizeMessageParams, createTask, appendMessage, assertCapacity, publicTask, protocolError } = require('./protocol');

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

function requireAuthorization(req, token) {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function createBrokerServer({ statePath, token = process.env.A2A_BROKER_TOKEN, now = () => new Date().toISOString() } = {}) {
  const store = new TaskStore(statePath || path.join(ROOT, 'state', 'tasks.json'));
  store.load();
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') return json(res, 200, facilitatorCard());
    const cardMatch = req.method === 'GET' && req.url.match(/^\/agents\/([a-z-]+)\/\.well-known\/agent-card\.json$/);
    if (cardMatch) return json(res, 200, agentCard(cardMatch[1]));
    if (req.method !== 'POST' || req.url !== '/rpc') return json(res, 404, { error: 'not_found' });
    if (!requireAuthorization(req, token)) return json(res, 401, { error: 'unauthorized' });

    let rpcId = null;
    try {
      const request = await readJson(req);
      rpcId = request.id ?? null;
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw protocolError('invalid JSON-RPC request');
      if (request.method === 'SendMessage') {
        const message = normalizeMessageParams(request.params);
        const task = message.taskId ? store.get(message.taskId) : null;
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
        return json(res, 200, { jsonrpc: '2.0', id: rpcId, result: publicTask(task) });
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
  if (host !== DEFAULT_HOST && !token) {
    throw new Error('A2A_BROKER_TOKEN is required when A2A_BROKER_HOST is not 127.0.0.1');
  }
  const port = Number(process.env.A2A_BROKER_PORT || DEFAULT_PORT);
  createBrokerServer({ token }).listen(port, host, () => {
    process.stdout.write(`AutoResearch A2A task broker listening on http://${host}:${port}\n`);
  });
}

module.exports = { createBrokerServer, facilitatorCard, agentCard };
