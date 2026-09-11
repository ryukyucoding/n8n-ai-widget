'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scrubText, sanitizePlanSpec, assertNoSecrets } = require('./planSpecSanitizer');

const DEFAULT_EVIDENCE_PATH = '/var/lib/n8n-chatbot/evidence/conversations.jsonl';
const MAX_TEXT_LENGTH = 8000;
const MAX_PLAN_BYTES = 64 * 1024;

function boundedText(value) {
  const { text } = scrubText(typeof value === 'string' ? value : '');
  const redactedAssignments = text.replace(
    /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, key) => `${key}=«redacted»`,
  );
  return redactedAssignments.length > MAX_TEXT_LENGTH
    ? `${redactedAssignments.slice(0, MAX_TEXT_LENGTH)}…`
    : redactedAssignments;
}

function safePlan(planSpec) {
  if (!planSpec || typeof planSpec !== 'object') return null;
  try {
    assertNoSecrets(planSpec);
    const plan = sanitizePlanSpec(planSpec);
    if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > MAX_PLAN_BYTES) return null;
    return plan;
  } catch (_) {
    return null;
  }
}

function planOperations(planSpec) {
  const plan = safePlan(planSpec);
  if (!plan || !Array.isArray(plan.steps)) return [];
  return plan.steps.map((step) => {
    const configuration = step && step.configuration && typeof step.configuration === 'object'
      ? step.configuration
      : {};
    return configuration.operation || step.operation || step.capability || '?';
  });
}

function createConversationEvidenceLogger({
  filePath = process.env.CONVERSATION_EVIDENCE_PATH || DEFAULT_EVIDENCE_PATH,
  enabled = String(process.env.CONVERSATION_EVIDENCE_ENABLED || 'false').toLowerCase() === 'true',
  now = Date.now,
  fsModule = fs,
  pathModule = path,
} = {}) {
  let directoryReady = false;

  function ensureDirectory() {
    if (directoryReady) return;
    fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true, mode: 0o700 });
    directoryReady = true;
  }

  function record(event = {}) {
    if (!enabled) return { recorded: false, reason: 'disabled' };
    const planSpec = safePlan(event.planSpec);
    const entry = {
      timestamp: new Date(now()).toISOString(),
      event: boundedText(event.event || 'conversation_turn'),
      conversationId: boundedText(event.conversationId),
      turn: Number.isInteger(event.turn) ? event.turn : null,
      route: boundedText(event.route),
      userMessage: boundedText(event.userMessage),
      assistantMessage: boundedText(event.assistantMessage),
      outcome: boundedText(event.outcome),
      status: boundedText(event.status),
      inputRedacted: event.inputRedacted === true,
      stepCount: planSpec && Array.isArray(planSpec.steps) ? planSpec.steps.length : 0,
      operations: planOperations(event.planSpec),
      planSpec,
      provenance: 'simulated',
    };
    try {
      ensureDirectory();
      fsModule.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      return { recorded: true };
    } catch (error) {
      // Evidence must never turn a valid planning request into a failed request.
      console.error('[conversation-evidence] write_failed');
      return { recorded: false, reason: 'write_failed' };
    }
  }

  return { record, filePath, enabled: () => enabled };
}

module.exports = {
  DEFAULT_EVIDENCE_PATH,
  createConversationEvidenceLogger,
};
