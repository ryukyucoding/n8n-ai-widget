'use strict';

// This runner intentionally contains only named, disposable regression cases.
// It never lists, executes, or deletes an arbitrary user workflow.
const { verifyCandidateWorkflow } = require('../src/candidateWorkflowVerifier');

const CASES = {
  C01: {
    prefix: '__codex_eval__C01__',
    request: 'Create a manual no-operation workflow for the C01 whitelist regression.',
    workflow: {
      name: '__codex_eval__C01__basic-create',
      nodes: [
        { id: 'manual', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [240, 300], parameters: {} },
        { id: 'noop', name: 'No Operation', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [460, 300], parameters: {} },
      ],
      connections: { 'Manual Trigger': { main: [[{ node: 'No Operation', type: 'main', index: 0 }]] } },
      settings: { executionOrder: 'v1' },
    },
  },
  C07: {
    prefix: '__codex_eval__C07__',
    request: 'Fetch JSONPlaceholder user 1 and todos, then output name, email, totalTodos, and incompleteTodos.',
    workflow: {
      name: '__codex_eval__C07__jsonplaceholder-summary',
      nodes: [
        { id: 'manual', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [240, 300], parameters: {} },
        { id: 'user', name: 'Get User', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [460, 300], parameters: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/users/1', options: {} } },
        { id: 'todos', name: 'Get Todos', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [680, 300], parameters: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos?userId=1', options: {} } },
        { id: 'summary', name: 'Build Summary', type: 'n8n-nodes-base.code', typeVersion: 2, position: [900, 300], parameters: { jsCode: "const user = $('Get User').first().json;\nconst todos = items.map((item) => item.json);\nreturn [{ json: { name: user.name, email: user.email, totalTodos: todos.length, incompleteTodos: todos.filter((todo) => !todo.completed).length } }];" } },
      ],
      connections: {
        'Manual Trigger': { main: [[{ node: 'Get User', type: 'main', index: 0 }]] },
        'Get User': { main: [[{ node: 'Get Todos', type: 'main', index: 0 }]] },
        'Get Todos': { main: [[{ node: 'Build Summary', type: 'main', index: 0 }]] },
      },
      settings: { executionOrder: 'v1' },
    },
  },
};

function requireCase(name) {
  const testCase = CASES[name];
  if (!testCase) throw new Error('only C01 and C07 whitelist cases are supported');
  return testCase;
}

function headers() {
  if (!process.env.N8N_API_KEY) throw new Error('N8N_API_KEY is required for whitelist runner');
  return { 'Content-Type': 'application/json', 'X-N8N-API-KEY': process.env.N8N_API_KEY };
}

async function create(caseName) {
  const testCase = requireCase(caseName);
  const base = process.env.N8N_BASE_URL;
  if (!base) throw new Error('N8N_BASE_URL is required for whitelist runner');
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest: testCase.request, candidateWorkflow: testCase.workflow }, { n8nBaseUrl: base, n8nApiKey: process.env.N8N_API_KEY });
  if (!['pass', 'warning'].includes(verification.status)) throw new Error(`verification failed: ${verification.errors.join('; ')}`);
  const post = await fetch(`${base}/api/v1/workflows`, { method: 'POST', headers: headers(), body: JSON.stringify(verification.workflow) });
  if (!post.ok) throw new Error(`create failed: ${post.status}`);
  const created = await post.json();
  if (!created.id || !String(created.name).startsWith(testCase.prefix)) throw new Error('unexpected whitelist workflow identity');
  const get = await fetch(`${base}/api/v1/workflows/${encodeURIComponent(created.id)}`, { headers: headers() });
  if (!get.ok) throw new Error(`exact readback failed: ${get.status}`);
  const readback = await get.json();
  if (String(readback.id) !== String(created.id) || readback.name !== created.name || !Array.isArray(readback.nodes) || !readback.connections || typeof readback.connections !== 'object') throw new Error('readback contract failed');
  console.log(JSON.stringify({ case: caseName, workflowId: String(created.id), workflowName: created.name, verified: verification.status, readback: true }));
}

async function cleanup(caseName, workflowId) {
  const testCase = requireCase(caseName);
  if (!workflowId) throw new Error('workflow ID is required for cleanup');
  const base = process.env.N8N_BASE_URL;
  const get = await fetch(`${base}/api/v1/workflows/${encodeURIComponent(workflowId)}`, { headers: headers() });
  if (!get.ok) throw new Error(`pre-cleanup readback failed: ${get.status}`);
  const workflow = await get.json();
  if (String(workflow.id) !== String(workflowId) || !String(workflow.name).startsWith(testCase.prefix)) throw new Error('refusing cleanup for non-whitelist workflow');
  const del = await fetch(`${base}/api/v1/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE', headers: headers() });
  if (!del.ok) throw new Error(`cleanup failed: ${del.status}`);
  console.log(JSON.stringify({ case: caseName, workflowId: String(workflowId), cleaned: true }));
}

(async () => {
  const [action, caseName, workflowId] = process.argv.slice(2);
  if (action === 'create') await create(caseName);
  else if (action === 'cleanup') await cleanup(caseName, workflowId);
  else throw new Error('usage: create|cleanup C01|C07 [workflowId]');
})().catch((error) => { console.error(error.message); process.exit(1); });
