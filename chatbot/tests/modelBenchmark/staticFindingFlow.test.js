'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStaticVerifier } = require('./runCandidateAStaticPilot');
const { runCreateModelPilot } = require('./runCreateModelPilot');

const root = path.resolve(__dirname, '..', '..');
const testCase = { caseId: 'C01', userRequest: 'fixture request', acceptanceContract: {}, executionEvidencePolicy: 'safe_execution_assertion' };
const candidates = [{ slot: 'candidate_a', modelTag: 'model-a' }];
const workflow = { nodes: [], connections: {} };

function childEnvelope(envelope, status = envelope.ok ? 0 : 1) {
  return () => ({ status, signal: null, stderr: '', stdout: JSON.stringify(envelope) });
}

async function runOne(verifyStatic, candidateWorkflow = workflow) {
  return runCreateModelPilot({
    candidates,
    cases: [testCase],
    repeats: 1,
    generate: async () => ({ rawOutput: candidateWorkflow }),
    verifyStatic,
  });
}

test('structured parameter-schema child finding reaches the benchmark parameter_schema bucket', async () => {
  const verifyStatic = createStaticVerifier({
    root,
    spawn: childEnvelope({
      ok: false,
      findings: [{ category: 'parameter_schema', severity: 'repair', repairable: true, normalized: false, blocking: true }],
      unstructuredFailure: false,
    }),
  });
  const report = await runOne(verifyStatic);
  const bucket = report.records[0].staticFindingSummary.parameter_schema;
  assert.equal(bucket.count, 1);
  assert.equal(bucket.blocking, true);
  assert.equal(report.records[0].staticFindingSummary.unknown_structural.count, 0);
  assert.doesNotMatch(JSON.stringify(report), /Hidden|privateValue|private message|fixture request|workflow|token|secret/i);
});

test("structured type-version child finding reaches type_version", async () => {
  const verifyStatic = createStaticVerifier({
    root,
    spawn: childEnvelope({ ok: false, findings: [{ category: "type_version", severity: "repair", repairable: true, normalized: false, blocking: true }], unstructuredFailure: false }),
  });
  const report = await runOne(verifyStatic);
  const bucket = report.records[0].staticFindingSummary.type_version;
  assert.equal(bucket.count, 1);
  assert.equal(bucket.blocking, true);
});

test('structured normalized port warning reaches connection_port and is not blocking', async () => {
  const verifyStatic = createStaticVerifier({
    root,
    spawn: childEnvelope({
      ok: true,
      findings: [{ category: 'connection_port', severity: 'warning', repairable: false, normalized: true, blocking: false }],
      unstructuredFailure: false,
    }),
  });
  const report = await runOne(verifyStatic);
  const bucket = report.records[0].staticFindingSummary.connection_port;
  assert.equal(bucket.count, 1);
  assert.equal(bucket.deterministicNormalization, 'fully_resolved');
  assert.equal(bucket.blocking, false);
});

test('shared deterministic dataflow finding reaches code_dataflow after a successful child envelope', async () => {
  const dataflowCandidate = {
    nodes: [
      { name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: "return [$('Missing').first()];" } },
    ],
    connections: { 'Manual Trigger': { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
  };
  const verifyStatic = createStaticVerifier({ root, spawn: childEnvelope({ ok: true, findings: [], unstructuredFailure: false }) });
  const report = await runOne(verifyStatic, dataflowCandidate);
  const bucket = report.records[0].staticFindingSummary.code_dataflow;
  assert.equal(bucket.count, 1);
  assert.equal(bucket.blocking, true);
  assert.doesNotMatch(JSON.stringify(report), /workflow|prompt|token|secret/i);
});

test('unstructured child error remains unknown_structural and is not reverse-classified', async () => {
  const verifyStatic = createStaticVerifier({ root, spawn: childEnvelope({ ok: false, findings: [], unstructuredFailure: true }) });
  const report = await runOne(verifyStatic);
  const summary = report.records[0].staticFindingSummary;
  assert.equal(summary.unknown_structural.count, 1);
  assert.equal(summary.unknown_structural.blocking, true);
  assert.equal(summary.parameter_schema.count, 0);
  assert.doesNotMatch(JSON.stringify(report), /Hidden|privateValue|fixture request|workflow|token|secret/i);
});
