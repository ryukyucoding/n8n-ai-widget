'use strict';

// Read-only, deterministic schema retrieval for the planner and any future
// workflow-engineer agent. It exposes no credentials, workflow data, or URLs.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SCHEMA_PATH = path.join(__dirname, '..', '..', 'chatbot', 'schemas', 'runtime_node_schemas.json');
const TOKEN_PATTERN = /[a-z0-9]{2,}/gi;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'using', 'user', 'data', 'workflow', 'create', 'make', 'get']);

function tokens(value) {
  return [...new Set((String(value || '').toLowerCase().match(TOKEN_PATTERN) || []).filter((token) => !STOP_WORDS.has(token)))];
}

function latestVersion(versions) {
  const keys = Object.keys(versions || {}).filter((version) => Number.isFinite(Number(version)));
  return keys.sort((left, right) => Number(right) - Number(left))[0] || null;
}

function safeParameter(property) {
  if (!property || typeof property !== 'object' || typeof property.name !== 'string') return null;
  return {
    name: property.name,
    type: typeof property.type === 'string' ? property.type : 'unknown',
    required: property.required === true,
    defaultDefined: Object.hasOwn(property, 'default'),
  };
}

function safeNodeDescriptor(type, entry) {
  const version = latestVersion(entry?.versions);
  const description = version ? entry.versions[version] : null;
  if (!description || typeof description !== 'object') return null;
  return {
    type,
    typeVersion: Number(version),
    displayName: typeof description.displayName === 'string' ? description.displayName : type,
    description: typeof description.description === 'string' ? description.description : '',
    aliases: Array.isArray(description?.codex?.alias) ? description.codex.alias.filter((item) => typeof item === 'string').slice(0, 8) : [],
    parameters: (Array.isArray(description.properties) ? description.properties : []).map(safeParameter).filter(Boolean).slice(0, 40),
    inputs: Array.isArray(description.inputs) ? description.inputs.map((item) => typeof item === 'string' ? item : item?.type).filter(Boolean) : [],
    outputs: Array.isArray(description.outputs) ? description.outputs.map((item) => typeof item === 'string' ? item : item?.type).filter(Boolean) : [],
    builderHint: typeof description?.builderHint?.message === 'string' ? description.builderHint.message : null,
  };
}

function catalogFromSchemas(nodeTypes) {
  if (!nodeTypes || typeof nodeTypes !== 'object') throw new TypeError('nodeTypes must be an object');
  return Object.entries(nodeTypes).map(([type, entry]) => safeNodeDescriptor(type, entry)).filter(Boolean);
}

function rankNode(descriptor, requestTokens) {
  const nameTokens = tokens(`${descriptor.type} ${descriptor.displayName} ${descriptor.aliases.join(' ')}`);
  const descriptionTokens = tokens(`${descriptor.description} ${descriptor.builderHint || ''}`);
  const parameterTokens = descriptor.parameters.flatMap((parameter) => tokens(parameter.name));
  let score = 0;
  for (const token of requestTokens) {
    if (nameTokens.includes(token)) score += 8;
    if (descriptionTokens.includes(token)) score += 3;
    if (parameterTokens.includes(token)) score += 2;
  }
  return score;
}

function retrieveRuntimeNodes({ userRequest, nodeTypes, limit = 12 }) {
  if (typeof userRequest !== 'string' || !userRequest.trim()) throw new TypeError('userRequest must be a non-empty string');
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new TypeError('limit must be an integer from 1 to 30');
  const requestTokens = tokens(userRequest);
  return catalogFromSchemas(nodeTypes)
    .map((descriptor) => ({ descriptor, score: rankNode(descriptor, requestTokens) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.descriptor.type.localeCompare(right.descriptor.type))
    .slice(0, limit)
    .map((result) => result.descriptor);
}

function loadRuntimeNodeTypes(schemaPath = DEFAULT_SCHEMA_PATH) {
  const payload = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  if (!payload?.nodeTypes || typeof payload.nodeTypes !== 'object') throw new Error('runtime schema export has no nodeTypes object');
  return payload.nodeTypes;
}

function buildRuntimePlanningContext({ userRequest, schemaPath = DEFAULT_SCHEMA_PATH, limit = 12 } = {}) {
  const candidateNodes = retrieveRuntimeNodes({ userRequest, nodeTypes: loadRuntimeNodeTypes(schemaPath), limit });
  return {
    schemaSource: 'installed_runtime_export',
    candidateNodes,
    instruction: 'Use only these node types and exact typeVersions unless the request needs clarification. Do not invent parameters outside the listed names. If a required service needs credentials, identify it as user setup rather than including a credential value.',
  };
}

module.exports = {
  DEFAULT_SCHEMA_PATH,
  buildRuntimePlanningContext,
  catalogFromSchemas,
  latestVersion,
  loadRuntimeNodeTypes,
  retrieveRuntimeNodes,
  safeNodeDescriptor,
  tokens,
};
