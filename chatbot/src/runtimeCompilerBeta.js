'use strict';

const crypto = require('node:crypto');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');

const SUPPORTED_PATTERNS = Object.freeze([
  { id: 'todo_summary', label: 'JSONPlaceholder user Todo summary' },
  { id: 'twitch_status', label: 'Twitch channel twitch live status' },
]);

function latestVersion(versions) {
  const values = Object.keys(versions || {}).filter((value) => Number.isFinite(Number(value)));
  return values.sort((left, right) => Number(right) - Number(left))[0] || null;
}

function card(type) {
  const version = latestVersion(runtimeSchemas.nodeTypes?.[type]?.versions);
  if (version === null) throw new Error(`installed runtime schema does not expose ${type}`);
  return { type, typeVersion: Number(version) };
}

function stableNodeId(label) {
  const hex = crypto.createHash('sha256').update(`runtime-compiler-beta:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function node(label, name, type, parameters, position) {
  return { id: stableNodeId(label), name, ...card(type), parameters, position };
}

function setParameters(assignments) {
  return { assignments: { assignments }, includeOtherFields: false, options: {} };
}

function todoSummaryWorkflow() {
  const nodes = [
    node('todo-start', 'Step 1: start', 'n8n-nodes-base.manualTrigger', {}, [240, 300]),
    node('todo-user', 'Step 2: user', 'n8n-nodes-base.httpRequest', { method: 'GET', url: 'https://jsonplaceholder.typicode.com/users/1', options: {} }, [500, 300]),
    node('todo-records', 'Step 3: todos', 'n8n-nodes-base.httpRequest', { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos?userId=1', options: {} }, [760, 300]),
    node('todo-summary', 'Step 4: summary', 'n8n-nodes-base.code', { jsCode: [
      "const source = $('Step 2: user').first().json;",
      'const records = $input.all().map((item) => item.json);',
      'const falseCount = records.filter((record) => record.completed === false).length;',
      'return [{ json: { name: source.name, email: source.email, totalTodos: records.length, incompleteTodos: falseCount } }];',
    ].join('\n') }, [1020, 300]),
  ];
  return {
    name: 'Runtime Compiler Beta - Todo Summary', active: false, settings: { executionOrder: 'v1' }, nodes,
    connections: {
      'Step 1: start': { main: [[{ node: 'Step 2: user', type: 'main', index: 0 }]] },
      'Step 2: user': { main: [[{ node: 'Step 3: todos', type: 'main', index: 0 }]] },
      'Step 3: todos': { main: [[{ node: 'Step 4: summary', type: 'main', index: 0 }]] },
    },
  };
}

function twitchStatusWorkflow() {
  const nodes = [
    node('twitch-start', 'Step 1: start', 'n8n-nodes-base.manualTrigger', {}, [240, 300]),
    node('twitch-channel', 'Step 2: channel', 'n8n-nodes-base.set', setParameters([{ name: 'channel', value: 'twitch', type: 'string' }]), [500, 300]),
    node('twitch-query', 'Step 3: lookup live status', 'n8n-nodes-base.httpRequest', {
      method: 'POST', url: 'https://gql.twitch.tv/gql', sendHeaders: true, specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Client-ID', value: 'kimne78kx3ncx6brgo4mv6wki5h1ko' }] },
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '{"query":"{ user(login: \\"twitch\\") { stream { id title } } }"}', options: {},
    }, [760, 300]),
    node('twitch-if', 'Step 4: is live', 'n8n-nodes-base.if', { conditions: { options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' }, combinator: 'and', conditions: [{ leftValue: '={{ $json.data.user.stream }}', rightValue: '', operator: { type: 'object', operation: 'notEmpty', singleValue: true } }] } }, [1020, 300]),
    node('twitch-online', 'Step 5a: online result', 'n8n-nodes-base.set', setParameters([{ name: 'channel', value: 'twitch', type: 'string' }, { name: 'isLive', value: true, type: 'boolean' }]), [1280, 220]),
    node('twitch-offline', 'Step 5b: offline result', 'n8n-nodes-base.set', setParameters([{ name: 'channel', value: 'twitch', type: 'string' }, { name: 'isLive', value: false, type: 'boolean' }]), [1280, 400]),
  ];
  return {
    name: 'Runtime Compiler Beta - Twitch Status', active: false, settings: { executionOrder: 'v1' }, nodes,
    connections: {
      'Step 1: start': { main: [[{ node: 'Step 2: channel', type: 'main', index: 0 }]] },
      'Step 2: channel': { main: [[{ node: 'Step 3: lookup live status', type: 'main', index: 0 }]] },
      'Step 3: lookup live status': { main: [[{ node: 'Step 4: is live', type: 'main', index: 0 }]] },
      'Step 4: is live': { main: [[{ node: 'Step 5a: online result', type: 'main', index: 0 }], [{ node: 'Step 5b: offline result', type: 'main', index: 0 }]] },
    },
  };
}

function normalizedRequest(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function compileBetaRequest(userRequest) {
  const request = normalizedRequest(userRequest);
  if (!request) return { status: 'unsupported', reason: 'empty_request', supportedPatterns: SUPPORTED_PATTERNS };
  if (/jsonplaceholder/.test(request) && /todo/.test(request) && /(user|使用者|用戶|profile)/.test(request)) {
    return { status: 'supported', pattern: 'todo_summary', workflow: todoSummaryWorkflow() };
  }
  if (/(twitch.*channel.*twitch|twitch.*頻道.*twitch|檢查.*twitch.*直播|twitch.*live status)/.test(request)) {
    return { status: 'supported', pattern: 'twitch_status', workflow: twitchStatusWorkflow() };
  }
  return { status: 'unsupported', reason: 'pattern_not_supported', supportedPatterns: SUPPORTED_PATTERNS };
}

module.exports = { SUPPORTED_PATTERNS, compileBetaRequest, todoSummaryWorkflow, twitchStatusWorkflow };
