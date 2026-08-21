'use strict';

const crypto = require('node:crypto');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');
const { compileDailyRssDigestSpecification, validateDailyRssDigestSpecification } = require('./rssDigestCompiler');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function latestCard(type) {
  const versions = Object.keys(runtimeSchemas.nodeTypes?.[type]?.versions || {})
    .filter((value) => Number.isFinite(Number(value)))
    .sort((left, right) => Number(right) - Number(left));
  assert(versions.length, `runtime does not expose ${type}`);
  return { type, typeVersion: Number(versions[0]) };
}

function nodeId(stepId) {
  const hex = crypto.createHash('sha256').update(`rss-email-draft:${stepId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function validateRssEmailDraftSpecification(value) {
  assert(value.kind === 'daily_rss_email_draft_specification', 'kind must be daily_rss_email_draft_specification');
  const digest = validateDailyRssDigestSpecification({ ...value, kind: 'daily_rss_digest_specification', requiredUserSetup: [] });
  assert(Array.isArray(value.requiredUserSetup), 'requiredUserSetup is required');
  assert(value.requiredUserSetup.includes('SMTP credential'), 'SMTP credential must be declared');
  assert(value.requiredUserSetup.includes('sender email'), 'sender email must be declared');
  assert(value.requiredUserSetup.includes('recipient email'), 'recipient email must be declared');
  assert(typeof value.emailSubject === 'string' && value.emailSubject.trim(), 'emailSubject is required');
  return { ...digest, emailSubject: value.emailSubject.trim() };
}

function compileDailyRssEmailDraft(specification) {
  const spec = validateRssEmailDraftSpecification(specification);
  const digestSpecification = { ...specification, kind: 'daily_rss_digest_specification', requiredUserSetup: [] };
  const workflow = compileDailyRssDigestSpecification(digestSpecification);
  const outputNode = workflow.nodes.at(-1);
  const emailName = 'Step 7: send email (setup required)';
  const emailNode = {
    id: nodeId('send-email'), name: emailName, ...latestCard('n8n-nodes-base.emailSend'),
    // Empty credential-bound fields deliberately keep this workflow a draft.
    parameters: { fromEmail: '', toEmail: '', subject: spec.emailSubject, emailFormat: 'text', text: '={{ $json.markdown }}', options: {} },
    position: [1500, 300],
  };
  workflow.name = `RSS email draft compiler - ${spec.goal}`;
  workflow.nodes.push(emailNode);
  workflow.connections[outputNode.name] = { main: [[{ node: emailName, type: 'main', index: 0 }]] };
  return workflow;
}

module.exports = { compileDailyRssEmailDraft, validateRssEmailDraftSpecification };
