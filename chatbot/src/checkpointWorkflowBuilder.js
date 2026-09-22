'use strict';

const NODE_KEYS = ['id', 'name', 'type', 'typeVersion', 'position', 'parameters'];

const DEFAULT_TICKETS = [
  { ticketId: 'T1', priority: 'high', title: 'Login fails' },
  { ticketId: 'T2', priority: 'normal', title: 'Slow page' },
  { ticketId: 'T3', priority: 'low', title: 'Typo' },
  { ticketId: 'T4', priority: 'high', title: 'Export broken' },
  { priority: 'high', title: 'No id' },
  { priority: 'normal', title: 'Also no id' },
  { ticketId: 'T7', title: 'No priority' },
  { ticketId: 'T1', priority: 'high', title: 'Duplicate' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableId(name) {
  return `cp1-${name}`;
}

function node({ id, name, type, typeVersion, position, parameters }) {
  return { id, name, type, typeVersion, position, parameters };
}

function buildCheckpoint1ValidateWorkflow(options = {}) {
  const tickets = clone(options.tickets || DEFAULT_TICKETS);
  assert(Array.isArray(tickets) && tickets.length > 0, 'tickets must be a non-empty array');
  for (const [index, ticket] of tickets.entries()) {
    assert(ticket && typeof ticket === 'object' && !Array.isArray(ticket), `tickets[${index}] must be an object`);
    assert(typeof ticket.title === 'string', `tickets[${index}].title must be a string`);
    if (ticket.ticketId !== undefined) assert(typeof ticket.ticketId === 'string', `tickets[${index}].ticketId must be a string`);
    if (ticket.priority !== undefined) assert(typeof ticket.priority === 'string', `tickets[${index}].priority must be a string`);
  }

  const start = node({
    id: stableId('start'),
    name: 'CP1 Start',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  });
  const source = node({
    id: stableId('source'),
    name: 'CP1 Fixture',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [220, 0],
    parameters: {
      options: {},
      assignments: {
        assignments: [{
          id: stableId('tickets-field'),
          name: 'tickets',
          type: 'array',
          value: JSON.stringify(tickets),
        }],
      },
    },
  });
  const split = node({
    id: stableId('split'),
    name: 'CP1 Expand Tickets',
    type: 'n8n-nodes-base.splitOut',
    typeVersion: 1,
    position: [440, 0],
    parameters: {
      fieldToSplitOut: 'tickets',
      include: 'noOtherFields',
      options: {},
    },
  });

  return {
    name: options.name || 'Generated CP1 Validate Fixture',
    nodes: [start, source, split],
    connections: {
      [start.name]: { main: [[{ node: source.name, type: 'main', index: 0 }]] },
      [source.name]: { main: [[{ node: split.name, type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  };
}

function deriveCheckpoint1Expected(tickets = DEFAULT_TICKETS) {
  return {
    inputCount: tickets.length,
    outputCount: tickets.length,
    outputItems: clone(tickets),
    fields: ['ticketId', 'priority', 'title'],
  };
}

function assertCheckpoint1Artifact(workflow, expected = {}) {
  assert(workflow && Array.isArray(workflow.nodes), 'workflow.nodes must be an array');
  assert(workflow.nodes.length === 3, `CP1 must contain 3 nodes, got ${workflow.nodes.length}`);
  for (const [index, item] of workflow.nodes.entries()) {
    assert(JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...NODE_KEYS].sort()), `node ${index} has non-canonical keys`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'credentials'), `node ${index} must not contain credentials`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'cid'), `node ${index} must not contain cid`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'creator'), `node ${index} must not contain creator`);
  }
  const names = workflow.nodes.map((item) => item.name);
  assert(names[0] === 'CP1 Start' && names[1] === 'CP1 Fixture' && names[2] === 'CP1 Expand Tickets', 'CP1 node order is not canonical');
  assert(workflow.nodes[1].parameters.assignments.assignments[0].type === 'array', 'CP1 fixture must use an array assignment');
  assert(workflow.nodes[2].parameters.fieldToSplitOut === 'tickets', 'CP1 split field must be tickets');
  assert(Object.keys(workflow.connections).length === 2, 'CP1 must have two connection sources');
  if (expected.inputCount !== undefined) {
    const actual = JSON.parse(workflow.nodes[1].parameters.assignments.assignments[0].value);
    assert(actual.length === expected.inputCount, 'CP1 fixture input count mismatch');
  }
  return true;
}

module.exports = {
  DEFAULT_TICKETS,
  NODE_KEYS,
  buildCheckpoint1ValidateWorkflow,
  deriveCheckpoint1Expected,
  assertCheckpoint1Artifact,
};
