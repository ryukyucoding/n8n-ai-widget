'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationEvidenceLogger } = require('./conversationEvidence');

function tempEvidencePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-conversation-evidence-'));
  return { dir, filePath: path.join(dir, 'conversations.jsonl') };
}

test('disabled logger does not create an evidence file', () => {
  const { dir, filePath } = tempEvidencePath();
  const logger = createConversationEvidenceLogger({ filePath, enabled: false });
  assert.deepEqual(logger.record({ event: 'turn' }), { recorded: false, reason: 'disabled' });
  assert.equal(fs.existsSync(filePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enabled logger writes a bounded sanitized JSONL event', () => {
  const { dir, filePath } = tempEvidencePath();
  const logger = createConversationEvidenceLogger({ filePath, enabled: true, now: () => 0 });
  const result = logger.record({
    event: 'turn',
    conversationId: 'conversation-1',
    turn: 2,
    route: 'conversation/message',
    userMessage: 'Please use api_key=TOP_SECRET to sort todos',
    assistantMessage: 'Plan ready',
    outcome: 'ready_to_compile',
    status: 'ready_to_confirm',
    inputRedacted: true,
    planSpec: {
      goal: 'sort todos',
      steps: [
        { capability: 'manual_trigger', configuration: { operation: 'manual_trigger' } },
        { capability: 'sort_items', configuration: { operation: 'sort_items', order: 'ascending' } },
      ],
    },
  });
  assert.deepEqual(result, { recorded: true });
  const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(entry.timestamp, '1970-01-01T00:00:00.000Z');
  assert.equal(entry.turn, 2);
  assert.equal(entry.stepCount, 2);
  assert.deepEqual(entry.operations, ['manual_trigger', 'sort_items']);
  assert.equal(entry.provenance, 'simulated');
  assert.match(entry.userMessage, /redacted/i);
  assert.doesNotMatch(JSON.stringify(entry), /TOP_SECRET/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('write failure is reported without throwing', () => {
  const logger = createConversationEvidenceLogger({
    filePath: '/evidence.jsonl',
    enabled: true,
    fsModule: { mkdirSync() { throw new Error('simulated_write_failure'); } },
  });
  assert.deepEqual(logger.record({ event: 'turn' }), { recorded: false, reason: 'write_failed' });
});
