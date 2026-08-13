'use strict';

const crypto = require('node:crypto');

const AGENT_IDS = new Set([
  'orchestrator',
  'evidence-researcher',
  'experiment-engineer',
  'execution-verifier',
  'debugger',
]);

const TASK_STATES = new Set([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
]);

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled']);
const MAX_TEXT_LENGTH = 8000;
const EXECUTION_HOSTS = new Set(['workstation-a', 'workstation-b', 'server']);
const RESOURCE_CLASSES = new Set(['light', 'cpu-bound', 'model-inference', 'n8n-operation']);
const MAX_ACTIVE_PER_HOST = new Map([
  ['cpu-bound', 1],
  ['model-inference', 1],
  ['n8n-operation', 1],
]);

function protocolError(message, code = -32602) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assertSafeText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw protocolError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw protocolError(`${field} exceeds the ${MAX_TEXT_LENGTH} character limit`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(api[_-]?key|authorization|bearer)\b/i.test(value)) {
    throw protocolError(`${field} appears to contain secret material`);
  }
  if (/[A-Za-z]:\\|\/(?:home|Users|etc|var|tmp)\//.test(value)) {
    throw protocolError(`${field} must not include an absolute local path`);
  }
  return value.trim();
}

function assertAgentId(agentId, field) {
  if (!AGENT_IDS.has(agentId)) {
    throw protocolError(`${field} is not an allowlisted agent ID`);
  }
  return agentId;
}

function normalizeArtifactRefs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw protocolError('artifactRefs must be an array with at most 10 references');
  }
  return value.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw protocolError(`artifactRefs[${index}] must be an object`);
    }
    const allowed = new Set(['repository', 'revision', 'path', 'sha256', 'summary']);
    for (const key of Object.keys(artifact)) {
      if (!allowed.has(key)) throw protocolError(`artifactRefs[${index}].${key} is not allowed`);
    }
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 || '')) {
      throw protocolError(`artifactRefs[${index}].sha256 must be a SHA-256 digest`);
    }
    return {
      repository: assertSafeText(artifact.repository, `artifactRefs[${index}].repository`),
      revision: assertSafeText(artifact.revision, `artifactRefs[${index}].revision`),
      path: assertSafeText(artifact.path, `artifactRefs[${index}].path`),
      sha256: artifact.sha256.toLowerCase(),
      summary: assertSafeText(artifact.summary, `artifactRefs[${index}].summary`),
    };
  });
}

function normalizeMessageParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw protocolError('params must be an object');
  }
  const allowed = new Set(['taskId', 'contextId', 'senderAgentId', 'assigneeAgentId', 'taskType', 'state', 'text', 'artifactRefs', 'executionHost', 'resourceClass']);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw protocolError(`params.${key} is not allowed`);
  }
  const senderAgentId = assertAgentId(params.senderAgentId, 'senderAgentId');
  const assigneeAgentId = assertAgentId(params.assigneeAgentId, 'assigneeAgentId');
  const state = params.state === undefined ? 'working' : params.state;
  if (!TASK_STATES.has(state)) throw protocolError('state is not supported');
  if (params.taskId !== undefined && !/^task_[a-f0-9-]+$/i.test(params.taskId)) {
    throw protocolError('taskId has an invalid format');
  }
  const executionHost = params.executionHost || 'workstation-a';
  const resourceClass = params.resourceClass || 'light';
  if (!EXECUTION_HOSTS.has(executionHost)) throw protocolError('executionHost is not allowlisted');
  if (!RESOURCE_CLASSES.has(resourceClass)) throw protocolError('resourceClass is not supported');
  return {
    taskId: params.taskId,
    contextId: params.contextId ? assertSafeText(params.contextId, 'contextId') : undefined,
    senderAgentId,
    assigneeAgentId,
    taskType: assertSafeText(params.taskType, 'taskType'),
    state,
    text: assertSafeText(params.text, 'text'),
    artifactRefs: normalizeArtifactRefs(params.artifactRefs),
    executionHost,
    resourceClass,
  };
}

function appendMessage(task, message, now) {
  if (TERMINAL_STATES.has(task.state) && message.state !== task.state) {
    throw protocolError('terminal tasks cannot change state');
  }
  if (message.senderAgentId !== task.assigneeAgentId && message.senderAgentId !== 'orchestrator') {
    throw protocolError('only the assignee or orchestrator may update a task');
  }
  if (message.assigneeAgentId !== task.assigneeAgentId && message.senderAgentId !== 'orchestrator') {
    throw protocolError('only the orchestrator may reassign a task');
  }
  if ((message.executionHost !== task.executionHost || message.resourceClass !== task.resourceClass)
    && message.senderAgentId !== 'orchestrator') {
    throw protocolError('only the orchestrator may change task resource placement');
  }
  const entry = {
    messageId: stableId('msg'),
    senderAgentId: message.senderAgentId,
    assigneeAgentId: message.assigneeAgentId,
    state: message.state,
    text: message.text,
    artifactRefs: message.artifactRefs,
    createdAt: now,
  };
  task.assigneeAgentId = message.assigneeAgentId;
  task.executionHost = message.executionHost;
  task.resourceClass = message.resourceClass;
  task.state = message.state;
  task.updatedAt = now;
  task.messages.push(entry);
  return task;
}

function createTask(message, now) {
  const task = {
    id: stableId('task'),
    contextId: message.contextId || stableId('ctx'),
    taskType: message.taskType,
    ownerAgentId: message.senderAgentId,
    assigneeAgentId: message.assigneeAgentId,
    executionHost: message.executionHost,
    resourceClass: message.resourceClass,
    state: 'submitted',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  return appendMessage(task, { ...message, state: message.state === 'working' ? 'submitted' : message.state }, now);
}

function publicTask(task) {
  return JSON.parse(JSON.stringify(task));
}

function assertCapacity(tasks, taskId, message) {
  const maximum = MAX_ACTIVE_PER_HOST.get(message.resourceClass);
  if (!maximum || message.state !== 'working') return;
  const active = tasks.filter((task) => task.id !== taskId
    && task.state === 'working'
    && task.executionHost === message.executionHost
    && task.resourceClass === message.resourceClass);
  if (active.length >= maximum) {
    throw protocolError(`capacity is occupied for ${message.resourceClass} on ${message.executionHost}`, -32009);
  }
}

function listInbox(tasks, agentId) {
  assertAgentId(agentId, 'agentId');
  return tasks.filter((task) => task.assigneeAgentId === agentId && task.state === 'submitted');
}

module.exports = {
  AGENT_IDS,
  TASK_STATES,
  normalizeMessageParams,
  createTask,
  appendMessage,
  assertCapacity,
  listInbox,
  publicTask,
  protocolError,
};
