'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadRuntimeNodeTypes, latestVersion } = require('../planning/runtimeSchemaCatalog');
const { verifyCandidateWorkflow } = require('../../chatbot/src/candidateWorkflowVerifier');

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

function card(type, nodeTypes) {
  const version = latestVersion(nodeTypes[type]?.versions);
  if (version === null) throw new Error(`installed runtime does not expose ${type}`);
  return { type, typeVersion: Number(version) };
}

function stableId(label) {
  const hex = require('node:crypto').createHash('sha256').update(`nodewise-twitch-status:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Easy-100 case 14, compiled against the installed runtime rather than reusing
// its legacy GraphQL node and parameter shape.
function twitchStatusWorkflow({ nodeTypes = loadRuntimeNodeTypes() } = {}) {
  const nodes = [
    { id: stableId('start'), name: 'Step 1: start', ...card('n8n-nodes-base.manualTrigger', nodeTypes), parameters: {}, position: [220, 300] },
    { id: stableId('channel'), name: 'Step 2: channel', ...card('n8n-nodes-base.set', nodeTypes), parameters: { assignments: { assignments: [{ name: 'channel', value: 'twitch', type: 'string' }] }, includeOtherFields: false, options: {} }, position: [480, 300] },
    { id: stableId('lookup'), name: 'Step 3: lookup live status', ...card('n8n-nodes-base.httpRequest', nodeTypes), parameters: {
      method: 'POST', url: 'https://gql.twitch.tv/gql', sendHeaders: true, specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Client-ID', value: TWITCH_CLIENT_ID }] },
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '{"query":"{ user(login: \\"twitch\\") { stream { id title } } }"}', options: {},
    }, position: [740, 300] },
    { id: stableId('is-live'), name: 'Step 4: is live', ...card('n8n-nodes-base.if', nodeTypes), parameters: { conditions: { options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' }, combinator: 'and', conditions: [{ leftValue: '={{ $json.data.user.stream }}', rightValue: '', operator: { type: 'object', operation: 'notEmpty', singleValue: true } }] } }, position: [1000, 300] },
    { id: stableId('online'), name: 'Step 5a: online result', ...card('n8n-nodes-base.set', nodeTypes), parameters: { assignments: { assignments: [{ name: 'channel', value: 'twitch', type: 'string' }, { name: 'isLive', value: true, type: 'boolean' }] }, includeOtherFields: false, options: {} }, position: [1260, 220] },
    { id: stableId('offline'), name: 'Step 5b: offline result', ...card('n8n-nodes-base.set', nodeTypes), parameters: { assignments: { assignments: [{ name: 'channel', value: 'twitch', type: 'string' }, { name: 'isLive', value: false, type: 'boolean' }] }, includeOtherFields: false, options: {} }, position: [1260, 400] },
  ];
  return {
    name: 'Nodewise Twitch status workflow', active: false, settings: { executionOrder: 'v1' }, nodes,
    connections: {
      'Step 1: start': { main: [[{ node: 'Step 2: channel', type: 'main', index: 0 }]] },
      'Step 2: channel': { main: [[{ node: 'Step 3: lookup live status', type: 'main', index: 0 }]] },
      'Step 3: lookup live status': { main: [[{ node: 'Step 4: is live', type: 'main', index: 0 }]] },
      'Step 4: is live': { main: [[{ node: 'Step 5a: online result', type: 'main', index: 0 }], [{ node: 'Step 5b: offline result', type: 'main', index: 0 }]] },
    },
  };
}

function safeReport(workflow, verification) {
  return {
    schemaVersion: '1.0', kind: 'nodewise_twitch_status_compiler_smoke', executionPolicy: 'no_n8n_create_or_execution',
    outcome: ['pass', 'warning'].includes(verification.status) ? 'static_pass' : 'static_blocked', verificationStatus: verification.status,
    nodeCards: workflow.nodes.map(({ type, typeVersion }) => ({ type, typeVersion })),
    findingRuleIds: verification.findings.map((finding) => finding.ruleId),
  };
}

async function run({ outputPath = process.env.TWITCH_COMPILER_OUTPUT_PATH } = {}) {
  if (!outputPath) throw new Error('TWITCH_COMPILER_OUTPUT_PATH is required');
  const workflow = twitchStatusWorkflow();
  const verification = await verifyCandidateWorkflow({ operation: 'create', userRequest: 'Check whether the public Twitch channel twitch is live and return channel and isLive.', candidateWorkflow: workflow });
  const report = safeReport(workflow, verification);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { TWITCH_CLIENT_ID, run, safeReport, twitchStatusWorkflow };
