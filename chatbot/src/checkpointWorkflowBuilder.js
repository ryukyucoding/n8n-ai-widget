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

const CP3_NORMALIZED_TICKETS = CP2_RAW_TICKETS.map((ticket) => ({
  ticketId: ticket.id === undefined ? null : ticket.id,
  priority: ticket.priority === undefined ? null : ticket.priority,
  title: ticket.subject,
}));

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
      ticketId: ticket.id === undefined ? null : ticket.id,
      priority: ticket.priority === undefined ? null : ticket.priority,
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

function buildCheckpoint3ValidateIdWorkflow(options = {}) {
  const tickets = clone(options.tickets || CP3_NORMALIZED_TICKETS);
  assert(Array.isArray(tickets) && tickets.length > 0, 'CP3 tickets must be a non-empty array');
  for (const [index, ticket] of tickets.entries()) {
    assert(ticket && typeof ticket === 'object' && !Array.isArray(ticket), `CP3 tickets[${index}] must be an object`);
    assert(typeof ticket.title === 'string', `CP3 tickets[${index}].title must be a string`);
    assert(ticket.ticketId === null || typeof ticket.ticketId === 'string', `CP3 tickets[${index}].ticketId must be null or a string`);
    assert(ticket.priority === null || typeof ticket.priority === 'string', `CP3 tickets[${index}].priority must be null or a string`);
  }

  const start = node({ id: 'cp3-start', name: 'CP3 Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} });
  const source = node({
    id: 'cp3-source', name: 'CP3 Normalized Fixture', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0],
    parameters: { options: {}, assignments: { assignments: [{ id: 'cp3-items-field', name: 'items', type: 'array', value: JSON.stringify(tickets) }] } },
  });
  const split = node({
    id: 'cp3-split', name: 'CP3 Expand Items', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [440, 0],
    parameters: { fieldToSplitOut: 'items', include: 'noOtherFields', options: {} },
  });
  const presence = node({
    id: 'cp3-presence', name: 'CP3 Compute Id Presence', type: 'n8n-nodes-base.code', typeVersion: 2, position: [660, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: [
        'return $input.all().map((item) => ({',
        '  json: { ...item.json, hasTicketId: item.json.ticketId !== null && item.json.ticketId !== undefined && item.json.ticketId !== \'\' },',
        '}));',
      ].join('\\n'),
    },
  });
  const branch = node({
    id: 'cp3-branch', name: 'CP3 Has Ticket Id?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [880, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ id: 'cp3-has-id', leftValue: '={{ $json.hasTicketId }}', rightValue: true, operator: { type: 'boolean', operation: 'true' } }],
        combinator: 'and',
      },
      options: {},
    },
  });
  const valid = node({
    id: 'cp3-valid', name: 'CP3 Mark Valid', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1100, -120],
    parameters: {
      mode: 'runOnceForAllItems', language: 'javaScript',
      jsCode: [
        'return $input.all().map((item) => {',
        '  const { hasTicketId, ...ticket } = item.json;',
        '  return { json: { ...ticket, rejected: false, rejectReason: \'\' } };',
        '});',
      ].join('\\n'),
    },
  });
  const invalid = node({
    id: 'cp3-invalid', name: 'CP3 Mark Missing Id', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1100, 120],
    parameters: {
      mode: 'runOnceForAllItems', language: 'javaScript',
      jsCode: [
        'return $input.all().map((item) => {',
        '  const { hasTicketId, ...ticket } = item.json;',
        '  return { json: { ...ticket, rejected: true, rejectReason: \'missing_ticket_id\' } };',
        '});',
      ].join('\\n'),
    },
  });

  return {
    name: options.name || 'Generated CP3 Validate Ticket Id Fixture',
    nodes: [start, source, split, presence, branch, valid, invalid],
    connections: {
      [start.name]: { main: [[{ node: source.name, type: 'main', index: 0 }]] },
      [source.name]: { main: [[{ node: split.name, type: 'main', index: 0 }]] },
      [split.name]: { main: [[{ node: presence.name, type: 'main', index: 0 }]] },
      [presence.name]: { main: [[{ node: branch.name, type: 'main', index: 0 }]] },
      [branch.name]: {
        main: [
          [{ node: valid.name, type: 'main', index: 0 }],
          [{ node: invalid.name, type: 'main', index: 0 }],
        ],
      },
    },
    settings: { executionOrder: 'v1' },
  };
}

function deriveCheckpoint3Expected(tickets = CP3_NORMALIZED_TICKETS) {
  return {
    inputCount: tickets.length,
    outputCount: tickets.length,
    rejectedCount: tickets.filter((ticket) => ticket.ticketId === null).length,
    outputItems: tickets.map((ticket) => ({ ...ticket, rejected: ticket.ticketId === null, rejectReason: ticket.ticketId === null ? 'missing_ticket_id' : '' })),
  };
}

function assertCheckpoint3Artifact(workflow, expected = {}) {
  assert(workflow && Array.isArray(workflow.nodes), 'CP3 workflow.nodes must be an array');
  assert(workflow.nodes.length === 7, `CP3 must contain 7 nodes, got ${workflow.nodes.length}`);
  for (const [index, item] of workflow.nodes.entries()) {
    assert(JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...NODE_KEYS].sort()), `CP3 node ${index} has non-canonical keys`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'credentials'), `CP3 node ${index} must not contain credentials`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'cid'), `CP3 node ${index} must not contain cid`);
    assert(!Object.prototype.hasOwnProperty.call(item, 'creator'), `CP3 node ${index} must not contain creator`);
  }
  assert(workflow.nodes[1].parameters.assignments.assignments[0].name === 'items', 'CP3 fixture field mismatch');
  assert(workflow.nodes[2].parameters.fieldToSplitOut === 'items', 'CP3 split field mismatch');
  assert(workflow.nodes[3].parameters.jsCode.includes('ticketId !== null'), 'CP3 must explicitly handle null ticket IDs');
  assert(workflow.nodes[4].parameters.conditions.conditions[0].operator.type === 'boolean', 'CP3 branch must use a boolean condition');
  if (expected.inputCount !== undefined) {
    const actual = JSON.parse(workflow.nodes[1].parameters.assignments.assignments[0].value);
    assert(actual.length === expected.inputCount, 'CP3 fixture input count mismatch');
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
  buildCheckpoint3ValidateIdWorkflow,
  deriveCheckpoint3Expected,
  assertCheckpoint3Artifact,
};
