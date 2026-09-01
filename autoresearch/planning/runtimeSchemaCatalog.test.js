'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildRuntimePlanningContext, explicitlyNamedRuntimeRequirements, planningContextStats, retrieveRuntimeNodes, safeNodeDescriptor } = require('./runtimeSchemaCatalog');

const nodeTypes = {
  'n8n-nodes-base.httpRequest': {
    versions: {
      '4.2': { displayName: 'HTTP Request', description: 'Makes an HTTP request to a URL', codex: { alias: ['API', 'REST'] }, properties: [{ name: 'url', type: 'string', default: '' }, { name: 'method', type: 'options', default: 'GET' }], inputs: ['main'], outputs: ['main'] },
      '4.4': { displayName: 'HTTP Request', description: 'Makes an HTTP request to a URL', codex: { alias: ['API', 'REST'] }, properties: [{ name: 'url', type: 'string', default: '' }, { name: 'method', type: 'options', default: 'GET' }], inputs: ['main'], outputs: ['main'] },
    },
  },
  'n8n-nodes-base.slack': {
    versions: { '2': { displayName: 'Slack', description: 'Send a Slack message', properties: [{ name: 'channel', type: 'string' }], inputs: ['main'], outputs: ['main'] } },
  },
  'n8n-nodes-base.n8n': {
    versions: { '1': { displayName: 'n8n', description: 'Manage this n8n instance', properties: [], inputs: ['main'], outputs: ['main'] } },
  },
};

test('retrieves current node versions using request terms without exposing property values', () => {
  const result = retrieveRuntimeNodes({ userRequest: 'Call a REST API URL and return the data', nodeTypes, limit: 2 });
  assert.equal(result[0].type, 'n8n-nodes-base.httpRequest');
  assert.equal(result[0].typeVersion, 4.4);
  assert.deepEqual(result[0].parameters[0], { name: 'url', type: 'string', required: false, defaultDefined: true });
});

test('keeps the schema context bounded and rejects blank requests', () => {
  assert.throws(() => retrieveRuntimeNodes({ userRequest: '', nodeTypes }), /non-empty/);
  assert.equal(safeNodeDescriptor('broken', { versions: {} }), null);
});

test('extracts explicit required and forbidden node requirements from the same runtime catalog', () => {
  const requirements = explicitlyNamedRuntimeRequirements({ userRequest: 'Use HTTP Request, but do not use Slack.', nodeTypes });
  assert.deepEqual(requirements.required, [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }]);
  assert.deepEqual(requirements.forbidden, [{ type: 'n8n-nodes-base.slack', typeVersion: 2 }]);
});

test('does not treat the platform name as an internal n8n node requirement or retrieval token', () => {
  const requirements = explicitlyNamedRuntimeRequirements({ userRequest: 'Create an n8n workflow with HTTP Request.', nodeTypes });
  assert.deepEqual(requirements.required, [{ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }]);
  const nodes = retrieveRuntimeNodes({ userRequest: 'Create an n8n workflow with HTTP Request.', nodeTypes, limit: 5 });
  assert.equal(nodes.some((node) => node.type === 'n8n-nodes-base.n8n'), false);
});

test('retains explicitly required node cards even when ranking is tightly bounded', () => {
  const root = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'runtime-context-'));
  const schemaPath = require('node:path').join(root, 'schema.json');
  require('node:fs').writeFileSync(schemaPath, JSON.stringify({ nodeTypes }));
  const context = buildRuntimePlanningContext({ userRequest: 'Use HTTP Request and Slack.', schemaPath, limit: 1 });
  assert.equal(context.candidateNodes.some((node) => node.type === 'n8n-nodes-base.httpRequest'), true);
  assert.equal(context.candidateNodes.some((node) => node.type === 'n8n-nodes-base.slack'), true);
});

test('compacts planner context to a bounded parameter inventory', () => {
  const context = buildRuntimePlanningContext({ userRequest: 'Call a REST API URL', schemaPath: require('node:path').join(__dirname, '..', '..', 'chatbot', 'schemas', 'runtime_node_schemas.json') });
  const stats = planningContextStats(context);
  assert.ok(stats.candidateNodeCount <= 5);
  assert.ok(context.candidateNodes.every((node) => node.parameters.length <= 6));
  assert.ok(stats.serializedCharCount > 0 && stats.serializedCharCount <= 4000);
});
