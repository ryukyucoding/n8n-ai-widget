'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadEasyCases, readinessFrom, runEasy100Batch, safeCapabilitySummary } = require('./runEasy100Batch');

function temporaryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy100-'));
  const input = path.join(root, 'input.jsonl');
  fs.writeFileSync(input, JSON.stringify({ id: 7, messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'original description' }, { role: 'assistant', content: '{"nodes":[]}' }] }) + '\n');
  return { root, input };
}

test('loads only the original user description', () => {
  const { input } = temporaryFixture();
  assert.deepEqual(loadEasyCases(input), [{ caseId: '7', description: 'original description' }]);
});

test('classifies static, setup, and sandbox states without claiming execution', () => {
  const parsed = { ok: true };
  assert.equal(readinessFrom({ parsed, verification: { status: 'repair' }, capability: {} }).category, 'static_blocked');
  assert.equal(readinessFrom({ parsed, verification: { status: 'pass' }, capability: { usesCredentials: true } }).category, 'requires_user_setup');
  assert.equal(readinessFrom({ parsed, verification: { status: 'pass' }, capability: { usesCredentials: false, writesExternally: false, hasCode: true } }).category, 'sandbox_required');
  assert.equal(readinessFrom({ parsed, verification: { status: 'pass' }, capability: { usesCredentials: false, writesExternally: false, hasCode: false } }).actualExecution, 'not_attempted');
});

test('checkpoints a generated candidate without an n8n call', async () => {
  const { root, input } = temporaryFixture();
  const workflow = { name: 'x', nodes: [{ name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} }], connections: {} };
  const report = await runEasy100Batch({ inputPath: input, outputDir: path.join(root, 'out'), generate: async () => ({ rawOutput: JSON.stringify(workflow), telemetry: { httpStatus: 200, contentType: 'application_json' } }), verify: async () => ({ status: 'pass', findings: [] }) });
  assert.equal(report.aggregate.attemptedCases, 1);
  assert.equal(report.aggregate.actualExecution.attempted, 0);
  assert.equal(report.records[0].executionReadiness.category, 'eligible_for_controlled_execution');
  assert.equal(fs.existsSync(path.join(root, 'out', 'private', 'predictions.jsonl')), true);
});

test('detects declared credentials without inspecting their values', () => {
  const summary = safeCapabilitySummary({ nodes: [{ type: 'n8n-nodes-base.googleDrive', credentials: { googleDriveOAuth2Api: { id: 'reference-only' } } }] });
  assert.equal(summary.usesCredentials, true);
  assert.equal(summary.writesExternally, true);
});

test('stops after one timeout instead of sending a follow-up request', async () => {
  const { root, input } = temporaryFixture();
  const report = await runEasy100Batch({
    inputPath: input,
    outputDir: path.join(root, 'out'),
    generate: async () => { throw { kind: 'timeout' }; },
  });
  assert.equal(report.stopReason, 'timeout');
  assert.equal(report.aggregate.attemptedCases, 1);
});
