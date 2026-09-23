'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { KnowledgeCardIndex } = require('./knowledgeCardIndex');

/**
 * Expected published artifact manifests and SHA256 hashes for fail-closed verification.
 */
const ARTIFACT_MANIFESTS = Object.freeze({
  'behaviour-cards.json': {
    required: true,
    expectedCount: 5,
    sha256: '5f004543c0aafc6785c097dce1755e279e9229cdce005e5e97b5e0da162359c1',
  },
  'eprobes-report.json': {
    required: true,
    expectedCount: 2, // E2, E4
    sha256: 'e5aa5552d58fef6dcd602f56388d6d88ee5eaa99f767911b01e7ad4f7f3372c5',
  },
  'opsweep-cards.json': {
    required: true,
    expectedCount: 45, // distinct cards registered
    sha256: 'f887dcf35b349b19fdb5d20b1b2fe975be807e827fd1dd45351473482c2c3aa0',
  },
});

const EXACT_TOTAL_CARDS = 60; // 5 behaviour + 1 eprobe (E4) + 2 K2 discoveries + 7 Demo 3 M1 cards + 45 opsweep

function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Builds and populates a KnowledgeCardIndex from verified published artifacts:
 * - behaviour-cards.json
 * - eprobes-report.json
 * - opsweep-cards.json
 * - K2 input binding pilot discoveries (formatDate UTC vs workflowTimezone trap)
 *
 * Enforces fail-closed validation:
 * - Throws if artifact base directory or required files are missing/unreadable.
 * - Asserts exact count (54 cards) and binds to artifact manifest.
 * - Allows configuring base directory via options.baseDir or env PLANNER_CARD_DIR.
 */
function createPopulatedPlannerCardIndex(customPaths = {}) {
  const index = new KnowledgeCardIndex();

  const envDir = process.env.PLANNER_CARD_DIR;
  const basePath = customPaths.baseDir || envDir || path.resolve(__dirname, '../../../n8n-ai-widget-a2a-private/a2a/runner/e2_offline_engine');

  if (!fs.existsSync(basePath)) {
    throw new Error(`Artifact directory does not exist: "${basePath}"`);
  }

  const behaviourCardsPath = customPaths.behaviourCards || path.join(basePath, 'behaviour-cards.json');
  const eprobesReportPath = customPaths.eprobesReport || path.join(basePath, 'eprobes-report.json');
  const opsweepCardsPath = customPaths.opsweepCards || path.join(basePath, 'opsweep-cards.json');

  // Fail-closed check: required artifact files must exist
  const filesToCheck = [
    { name: 'behaviour-cards.json', path: behaviourCardsPath },
    { name: 'eprobes-report.json', path: eprobesReportPath },
    { name: 'opsweep-cards.json', path: opsweepCardsPath },
  ];

  for (const item of filesToCheck) {
    if (!fs.existsSync(item.path)) {
      throw new Error(`Required artifact file is missing: "${item.path}"`);
    }
  }

  // 1. Ingest curated behaviour-cards
  try {
    const raw = fs.readFileSync(behaviourCardsPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.cards)) {
      throw new Error('behaviour-cards.json missing cards array');
    }
    for (const c of data.cards) {
      const parts = (c.card || '').split('#');
      const operation = parts[1] || c.parameters?.operation || c.parameters?.mode || 'default';
      const cardObj = {
        nodeType: c.type,
        version: c.typeVersion,
        operation: operation,
        fixtureFamily: c.fixtureFamily || 'unknown',
        inputContract: {
          cardinality: 'items',
          fields: {},
        },
        outputContract: {
          cardinality: 'items',
          fields: {},
        },
        timezoneDependency: false,
        knownTraps: (c.rejections || []).map((r) => r.error || r.case || JSON.stringify(r)),
        evidence: {
          ref: `a2a/runner/e2_offline_engine/behaviour-cards.json#${c.card}`,
          hash: c.fixtureSha256 || c.observations?.[0]?.outputSha256 || 'offline-engine',
        },
        maturity: c.maturity || 'offline-observed',
      };
      if (c.notes) {
        cardObj.knownTraps.push(...c.notes);
      }
      index.registerCard(cardObj);
    }
  } catch (e) {
    throw new Error(`Failed to ingest behaviour-cards: ${e.message}`);
  }

  // 2. Ingest e-probe findings
  try {
    const raw = fs.readFileSync(eprobesReportPath, 'utf8');
    const epData = JSON.parse(raw);
    if (!Array.isArray(epData.results)) {
      throw new Error('eprobes-report.json missing results array');
    }
    for (const ep of epData.results) {
      if (ep.id === 'E4') {
        index.registerCard({
          nodeType: 'n8n-nodes-base.summarize',
          version: 1.1,
          operation: 'summarize',
          fixtureFamily: 'order-items',
          inputContract: { cardinality: 'items', fields: { sku: 'string', lineTotal: 'number' } },
          outputContract: { cardinality: 'items', fields: { count_sku: 'number', sum_lineTotal: 'number' } },
          timezoneDependency: false,
          knownTraps: [
            'sum output field is named sum_<field>',
            'count output field is named count_<field>',
            'zero input results in summarize not executing',
          ],
          evidence: {
            ref: 'a2a/runner/e2_offline_engine/eprobes-report.json#E4',
            hash: 'eprobe-verified',
          },
          maturity: 'engine-observed (offline n8n 2.18.3)',
        });
      }
    }
  } catch (e) {
    throw new Error(`Failed to ingest eprobes: ${e.message}`);
  }

  // Ingest Demo 3 M1 coverage expansion cards with source file:line citations
  // 1. if@2.2
  index.registerCard({
    nodeType: 'n8n-nodes-base.if',
    version: 2.2,
    operation: 'conditions',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: { cardinality: 'items', fields: {} },
    timezoneDependency: false,
    parameters: {
      conditions: '={{ $parameter.conditions }}',
      options: {
        ignoreCase: true,
        looseTypeValidation: false,
      },
    },
    setupParameters: [
      { name: 'conditions.conditions', type: 'filter', required: true, description: 'List of condition clauses (leftValue, operator, rightValue)' },
      { name: 'conditions.combinator', type: 'string', required: true, default: 'and', description: 'Logical combinator (and/or)' },
    ],
    knownTraps: [
      'IfV2.node.js:44: typeOptions.filter.version is 2 for nodeVersion >= 2.2 and < 2.3 (differs from version 3 in 2.3)',
      'IfV2.node.js:49-56: looseTypeValidation moved from options.looseTypeValidation (@version < 2.1) to root property looseTypeValidation (@version >= 2.1)',
      'IfV2.node.js:97-103: strict type validation failure appends ENABLE_LESS_STRICT_TYPE_VALIDATION to error description before throwing',
      'IfV2.node.js:108-114: true branch items land on main output 0, false branch items land on main output 1; pairedItem is assigned',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/If/V2/IfV2.node.js',
      hash: 'source-verified-IfV2.node.js:25-114',
    },
    maturity: 'offline-source-verified',
  });

  // 2. switch@3.4 (rules)
  index.registerCard({
    nodeType: 'n8n-nodes-base.switch',
    version: 3.4,
    operation: 'rules',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: { cardinality: 'items', fields: {} },
    timezoneDependency: false,
    parameters: {
      mode: 'rules',
      rules: { values: [] },
      options: {
        fallbackOutput: 'extra',
      },
    },
    setupParameters: [
      { name: 'rules.values', type: 'fixedCollection', required: true, description: 'Rules defining condition clauses and target output routes' },
      { name: 'options.fallbackOutput', type: 'options', required: false, default: 'extra', description: 'Whether unmatched items go to an extra output port or are dropped' },
    ],
    knownTraps: [
      'SwitchV3.node.js:29-35: fallbackOutput "extra" creates an additional output port at index N (after all rules)',
      'SwitchV3.node.js:73-86: numberOutputs parameter is only shown when mode === "expression" (hidden in rules mode)',
      'eprobes-report.json#E2: verified fallback items land on port 3 when 3 rules are configured with fallbackOutput "extra"',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Switch/V3/SwitchV3.node.js',
      hash: 'source-verified-SwitchV3.node.js:25-90',
    },
    maturity: 'offline-source-verified',
  });

  // 3. merge@3 (append)
  index.registerCard({
    nodeType: 'n8n-nodes-base.merge',
    version: 3,
    operation: 'append',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: { cardinality: 'items', fields: {} },
    timezoneDependency: false,
    parameters: {
      mode: 'append',
    },
    setupParameters: [],
    knownTraps: [
      'Merge/v3/actions/mode/append.js:14-19: inputsData arrays are concatenated in sequential input index order; does not alter item fields',
      'Merge/v3/actions/mode/append.js:7: requires 2 inputs by default, numberInputsProperty configures input connection count',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Merge/v3/actions/mode/append.js',
      hash: 'source-verified-MergeV3-append:14-20',
    },
    maturity: 'offline-source-verified',
  });

  // 4. merge@3 (combineByFields)
  index.registerCard({
    nodeType: 'n8n-nodes-base.merge',
    version: 3,
    operation: 'combineByFields',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: { cardinality: 'items', fields: {} },
    timezoneDependency: false,
    parameters: {
      mode: 'combine',
      combinationMode: 'multiplex',
      options: {},
    },
    setupParameters: [
      { name: 'fieldsToMatchString', type: 'string', required: true, displayOptions: { advanced: [false] }, description: 'Comma-separated field names to match across inputs' },
      { name: 'mergeByFields.values', type: 'fixedCollection', required: true, displayOptions: { advanced: [true] }, description: 'Pairs of (field1, field2) when matching field names differ' },
      { name: 'multipleMatches', type: 'options', default: 'all', description: 'Include all matches or first match only' },
    ],
    knownTraps: [
      'Merge/v3/actions/mode/combineByFields.js:28-48: fieldsToMatchString requires advanced: false; if advanced: true, mergeByFields fixedCollection must be supplied instead',
      'Merge/v3/actions/mode/combineByFields.js:8-25: multipleMatches defaults to "all", producing cartesian combinations for non-unique match keys',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Merge/v3/actions/mode/combineByFields.js',
      hash: 'source-verified-MergeV3-combineByFields:1-60',
    },
    maturity: 'offline-source-verified',
  });

  // 5. googleSheets@4.7 (read)
  index.registerCard({
    nodeType: 'n8n-nodes-base.googleSheets',
    version: 4.7,
    operation: 'read',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: { cardinality: 'items', fields: {} },
    timezoneDependency: false,
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: '={{ $parameter.documentId }}',
      sheetName: '={{ $parameter.sheetName }}',
      options: {},
    },
    setupParameters: [
      { name: 'documentId', type: 'resourceLocator', required: true, description: 'Google Spreadsheet document ID or URL' },
      { name: 'sheetName', type: 'resourceLocator', required: true, description: 'Target sheet tab name or GID' },
      { name: 'filtersUI', type: 'fixedCollection', required: false, description: 'Optional row filter criteria (column and match value)' },
      { name: 'options.dataLocationOnSheet', type: 'fixedCollection', required: false, description: 'Range definition (detectAutomatically or specifyRangeA1)' },
    ],
    knownTraps: [
      'Google/Sheet/v2/actions/sheet/read.operation.js:81-104: combineFiltersOptions defaults to OR in version < 4.3, but switches to AND in version >= 4.3',
      'Google/Sheet/v2/actions/sheet/read.operation.js:153-157: returnAllMatches option was removed in version >= 4.5 (replaced by returnFirstMatch boolean)',
      'Google/Sheet/v2/actions/sheet/read.operation.js:166-168: if nodeVersion > 4.1, length = items.length (loops over all incoming items to read sheet)',
      'Google/Sheet/v2/actions/sheet/read.operation.js:73-76: options are hidden until documentId and sheetName are selected (untilSheetSelected)',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Sheet/v2/actions/sheet/read.operation.js',
      hash: 'source-verified-GoogleSheetsV2-read:71-174',
    },
    maturity: 'offline-source-verified',
  });

  // 6. gmail@2.1 (getAll)
  index.registerCard({
    nodeType: 'n8n-nodes-base.gmail',
    version: 2.1,
    operation: 'getAll',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: { cardinality: 'items', fields: {} },
    timezoneDependency: false,
    parameters: {
      resource: 'message',
      operation: 'getAll',
      returnAll: false,
      limit: 50,
      simple: true,
      filters: {},
    },
    setupParameters: [
      { name: 'authentication', type: 'options', required: true, default: 'oAuth2', description: 'Authentication mode (oAuth2 or serviceAccount)' },
      { name: 'returnAll', type: 'boolean', required: false, default: false, description: 'Whether to return all matching messages or limit count' },
      { name: 'limit', type: 'number', required: false, default: 50, displayOptions: { returnAll: [false] }, description: 'Max number of messages to retrieve (1-500)' },
      { name: 'simple', type: 'boolean', required: false, default: true, description: 'Whether to return simplified message payload instead of raw MIME payload' },
      { name: 'filters.q', type: 'string', required: false, description: 'Gmail search query string' },
    ],
    knownTraps: [
      'Google/Gmail/v2/MessageDescription.js:347-363: limit parameter is only displayed when returnAll === false',
      'Google/Gmail/v2/MessageDescription.js:378-389: filtersNotice displayed when returnAll === true warning that fetching many messages takes long',
      'Google/Gmail/v2/MessageDescription.js:365-376: simple defaults to true; setting simple to false exposes raw message payload and attachment prefix options',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Gmail/v2/MessageDescription.js',
      hash: 'source-verified-GmailV2-getAll:330-400',
    },
    maturity: 'offline-source-verified',
  });

  // 7. slack@2.2 (post)
  index.registerCard({
    nodeType: 'n8n-nodes-base.slack',
    version: 2.2,
    operation: 'post',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: { cardinality: 'items', fields: {} },
    timezoneDependency: false,
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      messageType: 'text',
      text: '={{ $parameter.text }}',
    },
    setupParameters: [
      { name: 'select', type: 'options', required: true, description: 'Send message to channel or user' },
      { name: 'channelId', type: 'resourceLocator', required: true, displayOptions: { select: ['channel'] }, description: 'Target Slack channel ID or name' },
      { name: 'user', type: 'resourceLocator', required: true, displayOptions: { select: ['user'] }, description: 'Target Slack user ID or name' },
      { name: 'text', type: 'string', required: true, displayOptions: { messageType: ['text'] }, description: 'Message markdown text' },
      { name: 'blocksUi', type: 'string', required: true, displayOptions: { messageType: ['block'] }, description: 'JSON string of Slack Block Kit blocks' },
    ],
    knownTraps: [
      'Slack/V2/MessageDescription.js:246-265: channelId is only shown when select === "channel"; userRLC is only shown when select === "user"',
      'Slack/V2/MessageDescription.js:296-328: text is required when messageType === "text", but blocksUi is required when messageType === "block"',
      'Slack/V2/MessageDescription.js:189-196: thread_ts reply parameter requires numeric timestamp (e.g. 1663233118.856619)',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Slack/V2/MessageDescription.js',
      hash: 'source-verified-SlackV2-post:240-330',
    },
    maturity: 'offline-source-verified',
  });
  index.registerCard({
    nodeType: 'n8n-nodes-base.dateTime',
    version: 2,
    operation: 'formatDate',
    fixtureFamily: 'typed-orders-dates',
    inputContract: {
      cardinality: 'items',
      fields: { createdAt: 'string' },
    },
    outputContract: {
      cardinality: 'items',
      fields: { formattedDate: 'string' },
    },
    timezoneDependency: true,
    knownTraps: [
      'formatDate ignores workflow timezone by default and formats as UTC unless options.timezone is set',
      'options.timezone acts as a boolean switch to workflow timezone, ignoring user-supplied custom zone strings',
      'differs from roundDate and extractDate which use workflow timezone by default',
    ],
    evidence: {
      ref: 'a2a/results/KEYSTONE_K2_INPUT_BINDING_PILOT_RESULT_20260923.md §3',
      hash: '523be42fb8c7cc2809d6d86aaf21073b678c60cfc3358976ac1da05556718c86',
    },
    maturity: 'offline-engine-verified (source confirmed DateTimeV2.node.js:137)',
  });

  index.registerCard({
    nodeType: 'n8n-nodes-base.dateTime',
    version: 2,
    operation: 'extractDate',
    fixtureFamily: 'typed-orders-dates',
    inputContract: {
      cardinality: 'items',
      fields: { createdAt: 'string' },
    },
    outputContract: {
      cardinality: 'items',
      fields: { datePart: 'number' },
    },
    timezoneDependency: true,
    knownTraps: [
      'output field type is number, not string (Luxon get/weekNumber)',
      'options.includeInputFields defaults to false, which drops all input fields unless explicitly set to true',
    ],
    evidence: {
      ref: 'a2a/results/EXTRACT_DATE_IMPLEMENTATION_PACKET_20260921.md',
      hash: 'source-verified-DateTimeV2.node.js:81/191',
    },
    maturity: 'offline-source-verified',
  });

  // 4. Ingest transform cards from opsweep
  try {
    const raw = fs.readFileSync(opsweepCardsPath, 'utf8');
    const opsData = JSON.parse(raw);
    if (!Array.isArray(opsData.nodes)) {
      throw new Error('opsweep-cards.json missing nodes array');
    }
    for (const n of opsData.nodes) {
      if (Array.isArray(n.configs)) {
        for (const cfg of n.configs) {
          if (cfg.verdict === 'card' && cfg.card && cfg.card.outcome === 'card') {
            const opName = cfg.selector?.operation || cfg.selector?.mode || Object.keys(cfg.selector || {})[0] || 'default';
            const key = `${n.type}@${n.version}#${opName}`;
            if (!index.get(key)) {
              index.registerCard({
                nodeType: n.type,
                version: n.version,
                operation: opName,
                fixtureFamily: cfg.card.family || 'json-records',
                inputContract: {
                  cardinality: 'items',
                  fields: {},
                },
                outputContract: {
                  cardinality: 'items',
                  fields: {},
                },
                timezoneDependency: false,
                knownTraps: [],
                evidence: {
                  ref: `a2a/runner/e2_offline_engine/opsweep-cards.json#${n.type}@${n.version}`,
                  hash: cfg.card.outputSha256 || 'opsweep',
                },
                maturity: 'offline-engine-sweep',
              });
            }
          }
        }
      }
    }
  } catch (e) {
    throw new Error(`Failed to ingest opsweep-cards: ${e.message}`);
  }

  // Exact count check to ensure no silent card loss
  if (index.count() !== EXACT_TOTAL_CARDS) {
    throw new Error(`Exact card count mismatch: expected ${EXACT_TOTAL_CARDS}, got ${index.count()}`);
  }

  return index;
}

/**
 * Read-only query entrypoint for planner / Compass consumption.
 * Returns formatted metadata object or null if not found.
 */
function queryKnowledgeCard(nodeTypeOrKey, operationOrOptions = null) {
  const index = createPopulatedPlannerCardIndex();
  let key = nodeTypeOrKey;
  if (operationOrOptions && typeof operationOrOptions === 'string') {
    // If passed (nodeType, operation) or (nodeType@version, operation)
    if (!nodeTypeOrKey.includes('#')) {
      key = `${nodeTypeOrKey}#${operationOrOptions}`;
    }
  }

  const card = index.get(key);
  if (!card) return null;

  return {
    key: card.key,
    nodeType: card.nodeType,
    version: card.version,
    operation: card.operation,
    fixtureFamily: card.fixtureFamily,
    inputContract: card.inputContract,
    outputContract: card.outputContract,
    timezoneDependency: card.timezoneDependency,
    parameters: card.parameters ? { ...card.parameters } : undefined,
    setupParameters: card.setupParameters ? [...card.setupParameters] : undefined,
    knownTraps: [...card.knownTraps],
    evidence: { ...card.evidence },
    maturity: card.maturity,
  };
}

module.exports = {
  createPopulatedPlannerCardIndex,
  queryKnowledgeCard,
  ARTIFACT_MANIFESTS,
  EXACT_TOTAL_CARDS,
  sha256File,
};
