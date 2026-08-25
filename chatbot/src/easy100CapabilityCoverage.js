'use strict';

const CONTROL_FLOW_TYPES = new Set([
  'n8n-nodes-base.if', 'n8n-nodes-base.switch', 'n8n-nodes-base.wait', 'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.merge', 'n8n-nodes-base.aggregate', 'n8n-nodes-base.limit', 'n8n-nodes-base.loopOverItems',
]);
const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.webhook',
  'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.formTrigger',
]);
const NON_EXECUTABLE_TYPES = new Set(['n8n-nodes-base.stickyNote', 'n8n-nodes-base.noOp']);
const CURRENT_EXACT_TYPES = new Set([
  'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.rssFeedRead',
  'n8n-nodes-base.httpRequest', 'n8n-nodes-base.set', 'n8n-nodes-base.code', 'n8n-nodes-base.limit',
  'n8n-nodes-base.emailSend',
]);

function increment(map, key, count = 1) {
  map[key] = (map[key] || 0) + count;
}

function sortedEntries(map) {
  return Object.entries(map).map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function parseWorkflowContent(content) {
  if (typeof content !== 'string') throw new Error('ground-truth assistant content is not a string');
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

function extractRecord(line, lineNumber) {
  const example = JSON.parse(line);
  const user = example.messages?.find((message) => message?.role === 'user')?.content;
  const assistant = example.messages?.find((message) => message?.role === 'assistant')?.content;
  if (typeof user !== 'string' || typeof assistant !== 'string') throw new Error('messages must contain user and assistant content');
  const workflow = parseWorkflowContent(assistant);
  if (!Array.isArray(workflow.nodes)) throw new Error('ground-truth workflow has no nodes array');
  return { caseId: String(example.id ?? lineNumber - 1), description: user, workflow };
}

function httpRequestCoverage(node) {
  const parameters = node.parameters || {};
  const url = typeof parameters.url === 'string' ? parameters.url : '';
  const hasCredential = Boolean(node.credentials && Object.keys(node.credentials).length);
  const safePublicGet = parameters.method === 'GET' && url.startsWith('https://') && !hasCredential;
  return safePublicGet ? null : 'http_post_or_authenticated_request';
}

function classifyNode(node) {
  const type = node.type || 'unknown';
  if (NON_EXECUTABLE_TYPES.has(type)) return null;
  if (type === 'n8n-nodes-base.manualTrigger') return null;
  if (type === 'n8n-nodes-base.httpRequest') return httpRequestCoverage(node);
  if (type === 'n8n-nodes-base.rssFeedRead') return 'rss_read_only_in_rss_digest_skill';
  if (type === 'n8n-nodes-base.scheduleTrigger') return 'schedule_only_in_rss_digest_skill';
  if (type === 'n8n-nodes-base.emailSend') return 'email_only_as_setup_required_draft';
  if (type === 'n8n-nodes-base.set') return 'mapping_semantics_not_yet_generalized';
  if (type === 'n8n-nodes-base.code') return 'arbitrary_code_semantics_not_supported';
  if (CONTROL_FLOW_TYPES.has(type)) return 'control_flow_skill_missing';
  if (TRIGGER_TYPES.has(type)) return 'trigger_or_human_interaction_skill_missing';
  if (type.startsWith('@n8n/n8n-nodes-langchain.')) return 'ai_service_skill_missing';
  if (/google|gmail|slack|notion|shopify|airtable|discord|telegram|microsoft|openAi|anthropic/i.test(type)) return 'credentialed_integration_skill_missing';
  if (node.credentials && Object.keys(node.credentials).length) return 'credentialed_integration_skill_missing';
  if (CURRENT_EXACT_TYPES.has(type)) return 'bounded_skill_context_missing';
  return 'node_skill_missing';
}

function auditRecords(records) {
  const nodeTypes = {};
  const blockers = {};
  const statusCounts = {};
  const cases = [];

  for (const record of records) {
    const caseBlockers = {};
    for (const node of record.workflow.nodes) {
      increment(nodeTypes, node.type || 'unknown');
      const blocker = classifyNode(node);
      if (blocker) increment(caseBlockers, blocker);
    }
    const blockerEntries = sortedEntries(caseBlockers);
    let status = 'ready_to_compile_candidate';
    if (blockerEntries.length) status = 'blocked_by_current_skill_library';
    increment(statusCounts, status);
    for (const { key, count } of blockerEntries) increment(blockers, key, count);
    cases.push({
      caseId: record.caseId,
      status,
      nodeCount: record.workflow.nodes.length,
      nodeTypes: [...new Set(record.workflow.nodes.map((node) => node.type || 'unknown'))].sort(),
      blockers: blockerEntries,
      descriptionPreview: record.description.replace(/\s+/g, ' ').slice(0, 220),
    });
  }
  return {
    schemaVersion: '1.0',
    kind: 'easy100_ground_truth_capability_coverage',
    evaluationScope: 'offline ground-truth capability coverage; no model invocation, workflow creation, or execution',
    currentSkillBoundary: 'Only compiler-owned semantics are counted as supported. A matching n8n node type alone is not treated as support.',
    aggregate: { caseCount: records.length, statuses: sortedEntries(statusCounts), nodeTypes: sortedEntries(nodeTypes), blockers: sortedEntries(blockers) },
    cases,
  };
}

function auditJsonLines(text) {
  const records = [];
  const parseFailures = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(extractRecord(line, index + 1));
    } catch (error) {
      parseFailures.push({ line: index + 1, message: error.message || String(error) });
    }
  });
  const report = auditRecords(records);
  report.parseFailures = parseFailures;
  return report;
}

module.exports = { auditJsonLines, auditRecords, classifyNode, extractRecord };
