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

const CP2_RAW_TICKETS = [
  { id: 'T1', priority: 'high', subject: 'Login fails' },
  { id: 'T2', priority: 'normal', subject: 'Slow page' },
  { id: 'T3', priority: 'low', subject: 'Typo' },
  { id: 'T4', priority: 'high', subject: 'Export broken' },
  { priority: 'high', subject: 'No id' },
  { priority: 'normal', subject: 'Also no id' },
  { id: 'T7', subject: 'No priority' },
  { id: 'T1', priority: 'high', subject: 'Duplicate' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
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

function buildCheckpoint2NormalizeWorkflow(options = {}) {
  const tickets = clone(options.tickets || CP2_RAW_TICKETS);
  assert(Array.isArray(tickets) && tickets.length > 0, 'CP2 tickets must be a non-empty array');
  for (const [index, ticket] of tickets.entries()) {
    assert(ticket && typeof ticket === 'object' && !Array.isArray(ticket), `CP2 tickets[${index}] must be an object`);
    assert(typeof ticket.subject === 'string', `CP2 tickets[${index}].subject must be a string`);
    if (ticket.id !== undefined) assert(typeof ticket.id === 'string', `CP2 tickets[${index}].id must be a string`);
    if (ticket.priority !== undefined) assert(typeof ticket.priority === 'string', `CP2 tickets[${index}].priority must be a string`);
  }

  const start = node({
    id: 'cp2-start',
    name: 'CP2 Start',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  });
  const source = node({
    id: 'cp2-source',
    name: 'CP2 Raw Fixture',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [220, 0],
    parameters: {
      options: {},
      assignments: {
        assignments: [{
          id: 'cp2-raw-tickets-field',
          name: 'rawTickets',
          type: 'array',
          value: JSON.stringify(tickets),
        }],
      },
    },
  });
  const split = node({
    id: 'cp2-split',
    name: 'CP2 Expand Raw Tickets',
    type: 'n8n-nodes-base.splitOut',
    typeVersion: 1,
    position: [440, 0],
    parameters: {
      fieldToSplitOut: 'rawTickets',
      include: 'noOtherFields',
      options: {},
    },
  });
  const normalize = node({
    id: 'cp2-normalize',
    name: 'CP2 Normalize Fields',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [660, 0],
    parameters: {
      includeOtherFields: false,
      options: {},
      assignments: {
        assignments: [
          { id: 'cp2-ticket-id', name: 'ticketId', type: 'string', value: '={{ $json.id }}' },
          { id: 'cp2-priority', name: 'priority', type: 'string', value: '={{ $json.priority }}' },
          { id: 'cp2-title', name: 'title', type: 'string', value: '={{ $json.subject }}' },
        ],
      },
    },
  });

  return {
    name: options.name || 'Generated CP2 Normalize Fixture',
    nodes: [start, source, split, normalize],
    connections: {
      [start.name]: { main: [[{ node: source.name, type: 'main', index: 0 }]] },
      [source.name]: { main: [[{ node: split.name, type: 'main', index: 0 }]] },
      [split.name]: { main: [[{ node: normalize.name, type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  };
}

function deriveCheckpoint2Expected(tickets = CP2_RAW_TICKETS) {
  return {
    inputCount: tickets.length,
    outputCount: tickets.length,
    outputItems: tickets.map((ticket) => ({
      ...(ticket.id === undefined ? {} : { ticketId: ticket.id }),
      ...(ticket.priority === undefined ? {} : { priority: ticket.priority }),
      title: ticket.subject,
    })),
    fields: ['ticketId', 'priority', 'title'],
  };
}

function assertCheckpoint2Artifact(workflow, expected = {}) {
  assert(workflow && Array.isArray(workflow.nodes), 'CP2 workflow.nodes must be an array');
  assert(workflow.nodes.length === 4, `CP2 must contain 4 nodes, got ${workflow.nodes.length}`);
  for (const [index, item] of workflow.nodes.entries()) {
    assert(JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...NODE_KEYS].sort()), `CP2 node ${index} has non-canonical keys`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'credentials'), `CP2 node ${index} must not contain credentials`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'cid'), `CP2 node ${index} must not contain cid`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'creator'), `CP2 node ${index} must not contain creator`);
  }
  assert(workflow.nodes[1].parameters.assignments.assignments[0].name === 'rawTickets', 'CP2 raw fixture field mismatch');
  assert(workflow.nodes[2].parameters.fieldToSplitOut === 'rawTickets', 'CP2 split field mismatch');
  assert(workflow.nodes[3].parameters.includeOtherFields === false, 'CP2 normalization must project canonical fields only');
  const assignments = workflow.nodes[3].parameters.assignments.assignments;
  assertDeepEqual(assignments.map((item) => item.name), ['ticketId', 'priority', 'title'], 'CP2 normalized assignment names mismatch');
  assertDeepEqual(assignments.map((item) => item.value), ['={{ $json.id }}', '={{ $json.priority }}', '={{ $json.subject }}'], 'CP2 normalized expressions mismatch');
  if (expected.inputCount !== undefined) {
    const actual = JSON.parse(workflow.nodes[1].parameters.assignments.assignments[0].value);
    assert(actual.length === expected.inputCount, 'CP2 fixture input count mismatch');
  }
  return true;
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
  CP2_RAW_TICKETS,
  NODE_KEYS,
  buildCheckpoint1ValidateWorkflow,
  deriveCheckpoint1Expected,
  assertCheckpoint1Artifact,
  buildCheckpoint2NormalizeWorkflow,
  deriveCheckpoint2Expected,
  assertCheckpoint2Artifact,
};
