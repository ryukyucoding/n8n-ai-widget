'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBenchmarkStructuralValidator, createRequest, findingCategoryCounts, loadEasyCases, readinessFrom, runEasy100Batch, safeCapabilitySummary, safeFindingCategory, safeHttpFailureCategory } = require('./runEasy100Batch');

function temporaryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy100-'));
  const input = path.join(root, 'input.jsonl');
  fs.writeFileSync(input, JSON.stringify({ id: 7, messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'original description' }, { role: 'assistant', content: '{"nodes":[]}' }] }) + '\n');
  return { root, input };
}

test('loads the source protocol and original user description but ignores gold output', () => {
  const { input } = temporaryFixture();
  assert.deepEqual(loadEasyCases(input), [{ caseId: '7', description: 'original description', systemPrompt: 'ignored' }]);
});

test('can disable JSON mode only for a bounded compatibility preflight', () => {
  const request = createRequest({ model: 'test-model', description: 'd', systemPrompt: 's', jsonMode: false });
  assert.equal(Object.hasOwn(request, 'response_format'), false);
  assert.equal(safeHttpFailureCategory('{"error":"response_format unsupported"}'), 'json_mode_rejected');
  assert.equal(safeHttpFailureCategory('{"error":"unknown"}'), 'http_failure_unclassified');
});

test('retains only a fixed safe category from the benchmark structural protocol', () => {
  const validator = createBenchmarkStructuralValidator({
    spawn: () => ({ status: 1, stdout: JSON.stringify({ ok: false, findings: [{ category: 'parameter_schema', severity: 'repair', repairable: true, normalized: false, blocking: true }], unstructuredFailure: false }) }),
  });
  assert.throws(() => validator({ candidateWorkflow: {}, userRequest: 'x' }), (error) => {
    assert.equal(safeFindingCategory(error.findings[0]), 'parameter_schema');
    assert.deepEqual(findingCategoryCounts({ findings: error.findings }), { parameter_schema: 1 });
    return true;
  });
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
