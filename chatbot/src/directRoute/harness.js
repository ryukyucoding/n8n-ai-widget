'use strict';

// Keystone E2 — offline n8n 2.18.3 engine harness (scratch; not product code).
// Runs a workflow JSON through the real n8n-core WorkflowExecute with real
// n8n-nodes-base node classes. Only credential-free, whitelisted nodes load.
// Code-node JavaScript is NOT run by n8n's task runner: startRunnerTask is a
// node:vm stand-in, and any run touching a Code node is labelled approximated.

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// Must be set before any n8n module reads config: InstanceSettings writes
// <userFolder>/.n8n/config on startup, and must never touch the real ~/.n8n.
const USER_FOLDER = path.join(__dirname, 'n8n-user');
process.env.N8N_USER_FOLDER = USER_FOLDER;
fs.mkdirSync(USER_FOLDER, { recursive: true });

// Timezone alignment with the runtime (TIMEZONE_RUNTIME_PARITY_ACCEPTANCE_20260923 @ 38245fb):
// workflow default zone (W) America/New_York, host process zone (H) UTC.
// Overridable only to measure timezone dependency (E2_WORKFLOW_TZ / E2_HOST_TZ).
const WORKFLOW_TZ = process.env.E2_WORKFLOW_TZ || 'America/New_York';
const HOST_TZ = process.env.E2_HOST_TZ || 'UTC';
process.env.TZ = HOST_TZ;

const { Workflow, NodeHelpers, createRunExecutionData, setGlobalState } = require('n8n-workflow');
setGlobalState({ defaultTimezone: WORKFLOW_TZ });
const { WorkflowExecute, ExecutionLifecycleHooks } = require('n8n-core');

const PKG_ROOT = path.dirname(require.resolve('n8n-nodes-base/package.json'));
const NODES_DIR = path.join(PKG_ROOT, 'dist', 'nodes');

// type -> [relative module path, export name]. Credential-free, no side effects.
const WHITELIST = {
  'n8n-nodes-base.manualTrigger': ['ManualTrigger/ManualTrigger.node.js', 'ManualTrigger'],
  'n8n-nodes-base.set': ['Set/Set.node.js', 'Set'],
  'n8n-nodes-base.splitOut': ['Transform/SplitOut/SplitOut.node.js', 'SplitOut'],
  'n8n-nodes-base.code': ['Code/Code.node.js', 'Code'],
  'n8n-nodes-base.if': ['If/If.node.js', 'If'],
  'n8n-nodes-base.filter': ['Filter/Filter.node.js', 'Filter'],
  'n8n-nodes-base.switch': ['Switch/Switch.node.js', 'Switch'],
  'n8n-nodes-base.merge': ['Merge/Merge.node.js', 'Merge'],
  'n8n-nodes-base.noOp': ['NoOp/NoOp.node.js', 'NoOp'],
  'n8n-nodes-base.removeDuplicates': ['Transform/RemoveDuplicates/RemoveDuplicates.node.js', 'RemoveDuplicates'],
  'n8n-nodes-base.sort': ['Transform/Sort/Sort.node.js', 'Sort'],
  'n8n-nodes-base.limit': ['Transform/Limit/Limit.node.js', 'Limit'],
  'n8n-nodes-base.renameKeys': ['RenameKeys/RenameKeys.node.js', 'RenameKeys'],
};

// Credential-requiring types for pinData experiments (E1-A). They load only when a
// run passes them in allowCredentialedTypes; credentials themselves never exist.
const CREDENTIALED = {
  'n8n-nodes-base.gmail': ['Google/Gmail/Gmail.node.js', 'Gmail'],
  'n8n-nodes-base.github': ['Github/Github.node.js', 'Github'],
};

class WhitelistNodeTypes {
  // extraTypes: { type: [path relative to the n8n-nodes-base package root, export] },
  // for experiments (E3-A) that load a caller-vetted credential-free node.
  constructor({ allowCredentialedTypes = [], extraTypes = {}, executed = [] } = {}) {
    this.cache = new Map();
    this.allowed = new Set(allowCredentialedTypes);
    this.extra = extraTypes;
    this.executed = executed;
    this.wrapped = new WeakSet();
  }
  load(type) {
    if (!this.cache.has(type)) {
      const extra = this.extra[type];
      const entry = WHITELIST[type] || (this.allowed.has(type) ? CREDENTIALED[type] : undefined) || extra;
      if (!entry) throw new Error(`node type not whitelisted for offline execution: ${type}`);
      const Ctor = require(path.join(extra && entry === extra ? PKG_ROOT : NODES_DIR, entry[0]))[entry[1]];
      if (typeof Ctor !== 'function') throw new Error(`export ${entry[1]} missing in ${entry[0]}`);
      this.cache.set(type, new Ctor());
    }
    return this.cache.get(type);
  }
  // Records every real node execution so a run can prove a pinned node never ran.
  track(type, nodeType) {
    if (!this.wrapped.has(nodeType) && typeof nodeType.execute === 'function') {
      const original = nodeType.execute;
      const executed = this.executed;
      nodeType.execute = function trackedExecute(...args) {
        executed.push({ type, node: this.getNode().name });
        return original.apply(this, args);
      };
      this.wrapped.add(nodeType);
    }
    return nodeType;
  }
  getByName(type) { return this.load(type); }
  getByNameAndVersion(type, version) { return this.track(type, NodeHelpers.getVersionedNodeType(this.load(type), version)); }
  getKnownTypes() { return {}; }
}

// APPROXIMATION: stands in for n8n's JS task runner. Provides only $input
// (all/first/last) for runOnceForAllItems and $json/$input.item for
// runOnceForEachItem; no n8n expression helpers ($, $node, $now, …).
function vmStartRunnerTask(approx) {
  return async (_additionalData, jobType, settings, _ctx, inputData) => {
    approx.used = true;
    if (jobType !== 'javascript') return { ok: false, error: { message: `vm stand-in does not support ${jobType}` } };
    const items = (inputData?.main?.[0] || []).map((item) => ({ json: structuredClone(item.json) }));
    const run = (sandbox) => vm.runInNewContext(`(function () {\n${settings.code}\n})()`, sandbox, { timeout: 5000 });
    try {
      if (settings.nodeMode === 'runOnceForAllItems') {
        const $input = { all: () => items, first: () => items[0], last: () => items.at(-1) };
        return { ok: true, result: await run({ $input, console }) };
      }
      const result = [];
      for (const item of items) {
        const out = await run({ $input: { item }, $json: item.json, console });
        if (out !== undefined && out !== null) result.push(out);
      }
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: { message: error.message, stack: error.stack } };
    }
  };
}

async function executeOffline(workflowJson, { pinData, allowCredentialedTypes = [], extraTypes = {} } = {}) {
  const executedNodes = [];
  const credentialLookups = [];
  const nodeTypes = new WhitelistNodeTypes({ allowCredentialedTypes, extraTypes, executed: executedNodes });
  const workflow = new Workflow({
    id: 'offline',
    name: workflowJson.name,
    nodes: workflowJson.nodes,
    connections: workflowJson.connections,
    active: false,
    nodeTypes,
    staticData: {},
    settings: workflowJson.settings || { executionOrder: 'v1' },
  });
  const approx = { used: false };
  const hooks = new ExecutionLifecycleHooks('manual', 'offline-1', workflowJson);
  const additionalData = {
    hooks,
    executionId: 'offline-1',
    variables: {},
    currentNodeParameters: undefined,
    restApiUrl: 'http://offline.invalid',
    instanceBaseUrl: 'http://offline.invalid',
    webhookBaseUrl: 'http://offline.invalid',
    webhookWaitingBaseUrl: 'http://offline.invalid',
    webhookTestBaseUrl: 'http://offline.invalid',
    formWaitingBaseUrl: 'http://offline.invalid',
    // Every credential access is recorded, then fails closed.
    credentialsHelper: new Proxy({}, { get: (_target, method) => (...args) => {
      credentialLookups.push({ method: String(method), type: typeof args[1] === 'string' ? args[1] : undefined });
      throw new Error('credentials are not available offline');
    } }),
    executeWorkflow: async () => { throw new Error('sub-workflows are not available offline'); },
    getRunExecutionData: async () => undefined,
    startRunnerTask: vmStartRunnerTask(approx),
    getRunnerStatus: () => ({ available: false, reason: 'offline harness' }),
    setExecutionStatus: () => {},
    sendDataToUI: () => {},
    logAiEvent: () => {},
  };
  const execute = new WorkflowExecute(additionalData, 'manual', createRunExecutionData());
  const run = await execute.run({ workflow, pinData });
  const runData = run.data.resultData.runData;
  const outputs = {};
  for (const [nodeName, taskRuns] of Object.entries(runData)) {
    const task = taskRuns.at(-1);
    const ports = task.data?.main || [];
    outputs[nodeName] = {
      executionStatus: task.executionStatus,
      error: task.error ? task.error.message : null,
      main: ports.map((port) => (port || []).map((item) => item.json)),
      // Binary metadata kept apart from main so JSON snapshots stay unchanged.
      binary: ports.map((port) => (port || []).map((item) => (item.binary ? Object.fromEntries(Object.entries(item.binary).map(([key, b]) => [key, {
        mimeType: b.mimeType, fileName: b.fileName, fileExtension: b.fileExtension, fileSize: b.fileSize,
        dataSha256: typeof b.data === 'string' ? require('node:crypto').createHash('sha256').update(b.data).digest('hex') : null,
        data: typeof b.data === 'string' && b.data.length <= 4096 ? b.data : undefined,
      }])) : null))),
    };
  }
  return {
    status: run.status,
    finished: run.finished,
    error: run.data.resultData.error ? run.data.resultData.error.message : null,
    codeNodeApproximated: approx.used,
    executedNodes,
    credentialLookups,
    outputs,
  };
}

module.exports = { executeOffline, WhitelistNodeTypes, WHITELIST, USER_FOLDER, WORKFLOW_TZ, HOST_TZ };
