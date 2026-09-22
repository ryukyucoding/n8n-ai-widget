'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');
const { verifyCandidateWorkflow } = require('../src/candidateWorkflowVerifier');
const {
  DEFAULT_TICKETS,
  CP2_RAW_TICKETS,
  NODE_KEYS,
  buildCheckpoint1ValidateWorkflow,
  deriveCheckpoint1Expected,
  assertCheckpoint1Artifact,
  buildCheckpoint2NormalizeWorkflow,
  deriveCheckpoint2Expected,
  assertCheckpoint2Artifact,
  buildCheckpoint3ValidateIdWorkflow,
  deriveCheckpoint3Expected,
  assertCheckpoint3Artifact,
  buildCheckpoint4ValidatePriorityWorkflow,
  deriveCheckpoint4Expected,
  assertCheckpoint4Artifact,
} = require('../src/checkpointWorkflowBuilder');

test('CP1 builds a deterministic three-node artifact from a literal requirement fixture', () => {
  const first = buildCheckpoint1ValidateWorkflow();
  const second = buildCheckpoint1ValidateWorkflow();

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assertCheckpoint1Artifact(first, { inputCount: DEFAULT_TICKETS.length });
  assert.equal(first.nodes.length, 3);
  assert.deepEqual(Object.keys(first.nodes[0]).sort(), [...NODE_KEYS].sort());
  assert.equal(first.nodes[0].type, 'n8n-nodes-base.manualTrigger');
  assert.equal(first.nodes[1].type, 'n8n-nodes-base.set');
  assert.equal(first.nodes[2].type, 'n8n-nodes-base.splitOut');
});

test('CP1 passes the shared structural and dataflow verifier', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'create',
    userRequest: 'Build the first validate checkpoint for a support-ticket workflow',
    candidateWorkflow: buildCheckpoint1ValidateWorkflow(),
  }, { runtimeSchemas });

  assert.equal(result.status, 'pass');
  assert.equal(result.verification.structural.status, 'pass');
  assert.equal(result.verification.dataflow.status, 'pass');
});

test('CP1 expected output is derived from the fixture rather than hand-counted', () => {
  const expected = deriveCheckpoint1Expected();
  assert.equal(expected.inputCount, 8);
  assert.equal(expected.outputCount, 8);
  assert.deepEqual(expected.fields, ['ticketId', 'priority', 'title']);
  assert.equal(expected.outputItems.filter((item) => item.ticketId === 'T1').length, 2);
});

test('CP2 builds a deterministic normalization checkpoint with an explicit raw fixture', () => {
  const first = buildCheckpoint2NormalizeWorkflow();
  const second = buildCheckpoint2NormalizeWorkflow();

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assertCheckpoint2Artifact(first, { inputCount: CP2_RAW_TICKETS.length });
  assert.equal(first.nodes.length, 4);
  assert.deepEqual(first.nodes.map((item) => item.type), [
    'n8n-nodes-base.manualTrigger',
    'n8n-nodes-base.set',
    'n8n-nodes-base.splitOut',
    'n8n-nodes-base.set',
  ]);
});

test('CP2 passes the shared structural and dataflow verifier', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'create',
    userRequest: 'Normalize raw support-ticket fields into the CP2 contract',
    candidateWorkflow: buildCheckpoint2NormalizeWorkflow(),
  }, { runtimeSchemas });

  assert.equal(result.status, 'pass');
  assert.equal(result.verification.structural.status, 'pass');
  assert.equal(result.verification.dataflow.status, 'pass');
});

test('CP2 derives the expected normalized field mapping from its fixture', () => {
  const expected = deriveCheckpoint2Expected();
  assert.equal(expected.inputCount, 8);
  assert.equal(expected.outputCount, 8);
  assert.deepEqual(expected.fields, ['ticketId', 'priority', 'title']);
  assert.deepEqual(expected.outputItems[0], { ticketId: 'T1', priority: 'high', title: 'Login fails' });
  assert.deepEqual(expected.outputItems[4], { ticketId: null, priority: 'high', title: 'No id' });
  assert.deepEqual(expected.outputItems[6], { ticketId: 'T7', priority: null, title: 'No priority' });
});

test('CP3 builds an explicit-null-aware id validation branch', () => {
  const first = buildCheckpoint3ValidateIdWorkflow();
  const second = buildCheckpoint3ValidateIdWorkflow();

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assertCheckpoint3Artifact(first, { inputCount: 8 });
  assert.equal(first.nodes.length, 7);
  assert.equal(first.nodes[3].parameters.mode, 'runOnceForAllItems');
  assert.equal(first.nodes[4].parameters.conditions.conditions[0].operator.operation, 'true');
});

test('CP3 passes the shared structural and dataflow verifier', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'create',
    userRequest: 'Reject support tickets with null ticket IDs',
    candidateWorkflow: buildCheckpoint3ValidateIdWorkflow(),
  }, { runtimeSchemas });

  assert.equal(result.status, 'pass');
  assert.equal(result.verification.structural.status, 'pass');
  assert.equal(result.verification.dataflow.status, 'pass');
});

test('CP3 expected result is computed from explicit null semantics', () => {
  const expected = deriveCheckpoint3Expected();
  assert.equal(expected.outputCount, 8);
  assert.equal(expected.rejectedCount, 2);
  assert.equal(expected.outputItems.filter((item) => item.rejected).length, 2);
  assert.equal(expected.outputItems.filter((item) => item.rejectReason === 'missing_ticket_id').length, 2);
});

test('CP4 preserves CP3 rejection decisions while validating priority', () => {
  const first = buildCheckpoint4ValidatePriorityWorkflow();
  const second = buildCheckpoint4ValidatePriorityWorkflow();

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assertCheckpoint4Artifact(first, { inputCount: 8 });
  assert.equal(first.nodes.length, 7);
});

test('CP4 passes the shared structural and dataflow verifier', async () => {
  const result = await verifyCandidateWorkflow({
    operation: 'create',
    userRequest: 'Preserve ticket ID rejections while rejecting null priorities',
    candidateWorkflow: buildCheckpoint4ValidatePriorityWorkflow(),
  }, { runtimeSchemas });

  assert.equal(result.status, 'pass');
  assert.equal(result.verification.structural.status, 'pass');
  assert.equal(result.verification.dataflow.status, 'pass');
});

test('CP4 expected result preserves the two CP3 rejections and adds one priority rejection', () => {
  const expected = deriveCheckpoint4Expected();
  assert.equal(expected.outputCount, 8);
  assert.equal(expected.rejectedCount, 3);
  assert.equal(expected.outputItems.filter((item) => item.rejected).length, 3);
  assert.equal(expected.outputItems.filter((item) => item.rejectReason === 'missing_ticket_id').length, 2);
  assert.equal(expected.outputItems.filter((item) => item.rejectReason === 'missing_priority').length, 1);
});

// Executes a CP3/CP4 artifact offline: parses the literal fixture, runs every code node's
// jsCode through a stub $input, and routes items by the if node's boolean condition along
// the artifact's own connections. Returns the items emitted by each terminal node.
function runCodeNode(codeNode, items) {
  const run = new Function('$input', codeNode.parameters.jsCode);
  return run({ all: () => items.map((item) => ({ json: { ...item.json } })) });
}

function executeBranchCheckpoint(workflow) {
  const byName = Object.fromEntries(workflow.nodes.map((item) => [item.name, item]));
  const next = (name, port = 0) => byName[workflow.connections[name].main[port][0].node];
  const [start] = workflow.nodes;
  const source = next(start.name);
  const split = next(source.name);
  const presence = next(split.name);
  const branch = next(presence.name);

  const fixture = JSON.parse(source.parameters.assignments.assignments[0].value);
  const splitItems = fixture.map((json) => ({ json }));
  const computed = runCodeNode(presence, splitItems);
  const condition = branch.parameters.conditions.conditions[0];
  const field = condition.leftValue.match(/\$json\.(\w+)/)[1];
  assert.equal(condition.operator.type, 'boolean');
  for (const item of computed) assert.equal(typeof item.json[field], 'boolean', `${field} must be a strict boolean`);

  const trueNode = next(branch.name, 0);
  const falseNode = next(branch.name, 1);
  const trueItems = computed.filter((item) => item.json[field] === true);
  const falseItems = computed.filter((item) => item.json[field] !== true);
  return {
    [trueNode.name]: runCodeNode(trueNode, trueItems).map((item) => item.json),
    [falseNode.name]: runCodeNode(falseNode, falseItems).map((item) => item.json),
  };
}

const byTitle = (items) => [...items].sort((a, b) => a.title.localeCompare(b.title));

test('CP3 and CP4 code nodes contain syntactically valid JavaScript', () => {
  for (const workflow of [buildCheckpoint3ValidateIdWorkflow(), buildCheckpoint4ValidatePriorityWorkflow()]) {
    const codeNodes = workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.code');
    assert.equal(codeNodes.length, 3);
    for (const codeNode of codeNodes) {
      assert.doesNotThrow(() => new Function('$input', codeNode.parameters.jsCode), `${codeNode.name} jsCode must parse`);
      assert.ok(!codeNode.parameters.jsCode.includes('\\n'), `${codeNode.name} jsCode must not contain a literal backslash-n`);
    }
  }
});

test('CP3 executed offline routes the two null-id rows to Mark Missing Id', () => {
  const outputs = executeBranchCheckpoint(buildCheckpoint3ValidateIdWorkflow());
  const valid = outputs['CP3 Mark Valid'];
  const missing = outputs['CP3 Mark Missing Id'];

  assert.equal(valid.length, 6);
  assert.equal(missing.length, 2);
  assert.deepEqual(missing.map((item) => item.title).sort(), ['Also no id', 'No id']);
  for (const item of missing) {
    assert.deepEqual(Object.keys(item).sort(), ['priority', 'rejectReason', 'rejected', 'ticketId', 'title']);
    assert.equal(item.ticketId, null);
    assert.equal(item.rejected, true);
    assert.equal(item.rejectReason, 'missing_ticket_id');
  }
  assert.ok(valid.every((item) => item.rejected === false && item.rejectReason === '' && !('hasTicketId' in item)));
  // "No priority" is still valid after CP3: CP3's contract is id presence only.
  assert.deepEqual(valid.find((item) => item.title === 'No priority'), { ticketId: 'T7', priority: null, title: 'No priority', rejected: false, rejectReason: '' });
  assert.deepEqual(byTitle([...valid, ...missing]), byTitle(deriveCheckpoint3Expected().outputItems));
});

test('CP4 executed offline preserves CP3 rejections and adds exactly one priority rejection', () => {
  const outputs = executeBranchCheckpoint(buildCheckpoint4ValidatePriorityWorkflow());
  const kept = outputs['CP4 Preserve Validity'];
  const missing = outputs['CP4 Mark Missing Priority'];
  const all = [...kept, ...missing];

  assert.equal(kept.length, 7);
  assert.equal(missing.length, 1);
  assert.equal(all.filter((item) => item.rejected).length, 3);
  assert.deepEqual(missing, [{ ticketId: 'T7', priority: null, title: 'No priority', rejected: true, rejectReason: 'missing_priority' }]);
  // The two CP3 rejections have a priority, so they take the true branch and must stay rejected.
  for (const title of ['No id', 'Also no id']) {
    const item = kept.find((row) => row.title === title);
    assert.equal(item.rejected, true, `${title} must stay rejected`);
    assert.equal(item.rejectReason, 'missing_ticket_id');
  }
  assert.ok(all.every((item) => !('hasPriority' in item)));
  assert.deepEqual(byTitle(all), byTitle(deriveCheckpoint4Expected().outputItems));
});

test('CP4 keeps the CP3 reason for a row missing both ticket ID and priority', () => {
  const cp3Input = [
    { ticketId: 'U1', priority: 'high', title: 'Complete' },
    { ticketId: null, priority: 'low', title: 'Missing id only' },
    { ticketId: 'U3', priority: null, title: 'Missing priority only' },
    { ticketId: null, priority: null, title: 'Missing both' },
  ];
  // Chain real CP3 execution output into CP4 instead of hand-writing the CP4 fixture.
  const cp3 = executeBranchCheckpoint(buildCheckpoint3ValidateIdWorkflow({ tickets: cp3Input }));
  const cp3Output = [...cp3['CP3 Mark Valid'], ...cp3['CP3 Mark Missing Id']];
  const cp4 = executeBranchCheckpoint(buildCheckpoint4ValidatePriorityWorkflow({ tickets: cp3Output }));
  const all = byTitle([...cp4['CP4 Preserve Validity'], ...cp4['CP4 Mark Missing Priority']]);

  assert.deepEqual(all.map((item) => [item.title, item.rejected, item.rejectReason]), [
    ['Complete', false, ''],
    ['Missing both', true, 'missing_ticket_id'],
    ['Missing id only', true, 'missing_ticket_id'],
    ['Missing priority only', true, 'missing_priority'],
  ]);
  assert.deepEqual(cp4['CP4 Mark Missing Priority'].map((item) => item.title).sort(), ['Missing both', 'Missing priority only']);
  assert.deepEqual(all, byTitle(deriveCheckpoint4Expected(cp3Output).outputItems));
});

test('CP1 rejects malformed fixtures before producing an artifact', () => {
  assert.throws(
    () => buildCheckpoint1ValidateWorkflow({ tickets: [{ ticketId: 7, title: 'bad' }] }),
    /ticketId must be a string/
  );
  assert.throws(
    () => buildCheckpoint1ValidateWorkflow({ tickets: [] }),
    /non-empty array/
  );
});
