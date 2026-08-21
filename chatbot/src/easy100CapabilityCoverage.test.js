'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { auditJsonLines } = require('./easy100CapabilityCoverage');

function line({ id, nodes }) {
  return JSON.stringify({ id, messages: [
    { role: 'user', content: `需求描述：case ${id}` },
    { role: 'assistant', content: JSON.stringify({ nodes }) },
  ] });
}

test('counts only compiler-owned public GET primitives as ready candidates', () => {
  const report = auditJsonLines(line({ id: 0, nodes: [
    { type: 'n8n-nodes-base.manualTrigger', parameters: {} },
    { type: 'n8n-nodes-base.httpRequest', parameters: { method: 'GET', url: 'https://example.test/data' } },
  ] }));
  assert.deepEqual(report.aggregate.statuses, [{ key: 'ready_to_compile_candidate', count: 1 }]);
  assert.equal(report.parseFailures.length, 0);
});

test('does not mistake a matching node type for semantic compiler support', () => {
  const report = auditJsonLines(line({ id: 1, nodes: [
    { type: 'n8n-nodes-base.manualTrigger', parameters: {} },
    { type: 'n8n-nodes-base.httpRequest', parameters: { method: 'POST', url: 'https://example.test/data' } },
    { type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items;' } },
    { type: 'n8n-nodes-base.googleDrive', credentials: { googleDriveOAuth2Api: { id: 'x' } }, parameters: {} },
  ] }));
  assert.deepEqual(report.cases[0].blockers, [
    { key: 'arbitrary_code_semantics_not_supported', count: 1 },
    { key: 'credentialed_integration_skill_missing', count: 1 },
    { key: 'http_post_or_authenticated_request', count: 1 },
  ]);
});

test('does not count template documentation nodes as runtime capability gaps', () => {
  const report = auditJsonLines(line({ id: 2, nodes: [
    { type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Setup notes' } },
    { type: 'n8n-nodes-base.manualTrigger', parameters: {} },
  ] }));
  assert.deepEqual(report.aggregate.statuses, [{ key: 'ready_to_compile_candidate', count: 1 }]);
});
