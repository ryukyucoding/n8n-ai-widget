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

// Total cards count:
// 5 behaviour + 1 eprobe (E4) + 2 K2 discoveries + 45 opsweep + 12 Demo 3 & 4 cards + 1 Filter card = 68 cards
const EXACT_TOTAL_CARDS = 68;

function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Builds and populates a KnowledgeCardIndex from verified published artifacts:
 * - behaviour-cards.json
 * - eprobes-report.json
 * - opsweep-cards.json
 * - K2 input binding pilot discoveries
 * - Demo 3 & Demo 4 Google-family knowledge cards
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

  // 3. Ingest Demo 3 Core Control & Transformation Cards
  // if@2.2
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

  // switch@3.4 (rules)
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

  // merge@3 (append)
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

  // merge@3 (combineByFields)
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

  // slack@2.2 (post)
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

  // 4. Ingest K2 input-binding synthesis discoveries (dateTime@2)
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

  // 5. Ingest Demo 4 Google-Family Cards with Exact Output Shapes
  // googleSheets@4.7 (read: all rows or lookup via filtersUI)
  index.registerCard({
    nodeType: 'n8n-nodes-base.googleSheets',
    version: 4.7,
    operation: 'read',
    fixtureFamily: 'google-sheets-data',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: { row_number: 'number' },
      extra: 'sheet-columns',
      shape: 'user-sheet-dependent',
    },
    timezoneDependency: false,
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: '={{ $parameter.documentId }}',
      sheetName: '={{ $parameter.sheetName }}',
      options: {
        returnFirstMatch: false,
      },
    },
    setupParameters: [
      { name: 'documentId', type: 'resourceLocator', required: true, description: 'Google Spreadsheet document ID or URL' },
      { name: 'sheetName', type: 'resourceLocator', required: true, description: 'Target sheet tab name or GID' },
      { name: 'filtersUI', type: 'fixedCollection', required: false, description: 'Lookup filter column and match value pairs (when lookup is used)' },
      { name: 'combineFilters', type: 'options', default: 'AND', description: 'AND requires all conditions, OR requires at least one' },
      { name: 'options.dataLocationOnSheet', type: 'fixedCollection', required: false, description: 'Range definition (detectAutomatically or specifyRangeA1)' },
    ],
    knownTraps: [
      'Google/Sheet/v2/actions/sheet/read.operation.js:166-168: nodeVersion > 4.1 loops over all incoming items (length = items.length)',
      'Google/Sheet/v2/helpers/GoogleSheet.js:205-216: structureArrayDataByColumn generates col_<index> if keyRow headers are empty',
      'Google/Sheet/v2/helpers/GoogleSheets.types.js:4: row_number is an internal reserved key for row indexing',
      'Google/Sheet/v2/actions/sheet/read.operation.js:81-104: combineFiltersOptions defaults to OR in version < 4.3, but switches to AND in version >= 4.3 when filtersUI is provided',
      'Google/Sheet/v2/helpers/GoogleSheet.js:392-474: lookupValues removes empty columns via removeEmptyColumns before converting array to object array',
      'Google/Sheet/v2/helpers/GoogleSheet.js:424-468: combineFilters OR stops after first match if returnAllMatches !== true (cardinality change only, field set unchanged)',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Sheet/v2/actions/sheet/read.operation.js',
      hash: 'source-verified-GoogleSheetsV2-read:71-174',
    },
    maturity: 'offline-source-verified',
  });

  // googleSheets@4.7 (append)
  index.registerCard({
    nodeType: 'n8n-nodes-base.googleSheets',
    version: 4.7,
    operation: 'append',
    fixtureFamily: 'google-sheets-data',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {},
      shape: 'input-passthrough',
    },
    timezoneDependency: false,
    parameters: {
      resource: 'sheet',
      operation: 'append',
      documentId: '={{ $parameter.documentId }}',
      sheetName: '={{ $parameter.sheetName }}',
      columns: { mappingMode: 'autoMapInputData' },
      options: {},
    },
    setupParameters: [
      { name: 'documentId', type: 'resourceLocator', required: true, description: 'Target spreadsheet document ID' },
      { name: 'sheetName', type: 'resourceLocator', required: true, description: 'Target sheet tab' },
      { name: 'columns.mappingMode', type: 'options', default: 'autoMapInputData', description: 'autoMapInputData or defineBelow' },
    ],
    knownTraps: [
      'Google/Sheet/v2/actions/sheet/append.operation.js:253-258: returns items unchanged with pairedItem metadata attached in autoMapInputData mode (input passthrough)',
      'Google/Sheet/v2/actions/sheet/append.operation.js:209-216: version >= 4.4 checks for schema changes if mappingMode !== autoMapInputData and throws on column mismatches',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Sheet/v2/actions/sheet/append.operation.js',
      hash: 'source-verified-GoogleSheetsV2-append:250-268',
    },
    maturity: 'offline-source-verified',
  });

  // googleSheets@4.7 (update)
  index.registerCard({
    nodeType: 'n8n-nodes-base.googleSheets',
    version: 4.7,
    operation: 'update',
    fixtureFamily: 'google-sheets-data',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {},
      shape: 'input-passthrough',
    },
    timezoneDependency: false,
    parameters: {
      resource: 'sheet',
      operation: 'update',
      documentId: '={{ $parameter.documentId }}',
      sheetName: '={{ $parameter.sheetName }}',
      columns: { matchingColumns: ['row_number'] },
      options: {},
    },
    setupParameters: [
      { name: 'documentId', type: 'resourceLocator', required: true, description: 'Target spreadsheet document ID' },
      { name: 'sheetName', type: 'resourceLocator', required: true, description: 'Target sheet tab' },
      { name: 'columns.matchingColumns', type: 'multiOptions', required: true, description: 'Column names or row_number to match on for updates' },
    ],
    knownTraps: [
      'Google/Sheet/v2/actions/sheet/update.operation.js:377-379: matching on "row_number" bypasses index column lookup and directly updates by physical row number',
      'Google/Sheet/v2/actions/sheet/update.operation.js:398-403: returns incoming items array with pairedItem index in autoMapInputData mode',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Sheet/v2/actions/sheet/update.operation.js',
      hash: 'source-verified-GoogleSheetsV2-update:370-405',
    },
    maturity: 'offline-source-verified',
  });

  // gmail@2.1 (getAll: simple=true)
  index.registerCard({
    nodeType: 'n8n-nodes-base.gmail',
    version: 2.1,
    operation: 'getAll',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {
        id: 'string',
        threadId: 'string',
        snippet: 'string',
        labels: 'array',
        From: 'string',
        To: 'string',
        Cc: 'string|absent',
        Bcc: 'string|absent',
        Subject: 'string',
      },
      shape: 'fixed-simple-metadata',
    },
    timezoneDependency: false,
    parameters: {
      resource: 'message',
      operation: 'getAll',
      simple: true,
      returnAll: false,
      limit: 50,
      filters: {},
    },
    setupParameters: [
      { name: 'authentication', type: 'options', required: true, default: 'oAuth2', description: 'Authentication mode (oAuth2 or serviceAccount)' },
      { name: 'returnAll', type: 'boolean', required: false, default: false, description: 'Whether to return all matching messages or limit count' },
      { name: 'limit', type: 'number', required: false, default: 50, displayOptions: { returnAll: [false] }, description: 'Max number of messages to retrieve (1-500)' },
      { name: 'simple', type: 'boolean', required: false, default: true, description: 'Whether to return simplified message payload instead of raw MIME payload' },
    ],
    knownTraps: [
      'Google/Gmail/v2/GmailV2.node.js:307-325: simple=true fetches metadata format and extracts From, To, Cc, Bcc, Subject into root item JSON',
      'Google/Gmail/GenericFunctions.js:369-372: labels is an array of objects {id, name} produced by mapping labelIds against fetched labels',
      'Google/Gmail/GenericFunctions.js:380-386: Cc and Bcc headers are hoisted only when present on the message; otherwise absent',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Gmail/v2/MessageDescription.js',
      hash: 'source-verified-GmailV2-getAll-simple:330-400',
    },
    maturity: 'offline-source-verified',
  });

  // gmail@2.1 (getAllRaw: simple=false)
  index.registerCard({
    nodeType: 'n8n-nodes-base.gmail',
    version: 2.1,
    operation: 'getAllRaw',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {
        id: 'string',
        threadId: 'string',
        labelIds: 'array',
        sizeEstimate: 'number',
        text: 'string|absent',
        html: 'string|absent',
        textAsHtml: 'string|absent',
        subject: 'string|absent',
        date: 'string|absent',
        to: 'object|absent',
        from: 'object|absent',
        messageId: 'string|absent',
        headers: 'object',
      },
      shape: 'mailparser-parsed',
    },
    timezoneDependency: false,
    parameters: {
      resource: 'message',
      operation: 'getAll',
      simple: false,
      returnAll: false,
      limit: 50,
      options: {
        downloadAttachments: false,
      },
    },
    setupParameters: [
      { name: 'authentication', type: 'options', required: true, default: 'oAuth2', description: 'Authentication mode' },
      { name: 'simple', type: 'boolean', default: false, description: 'Set to false to parse full MIME email payload' },
      { name: 'options.downloadAttachments', type: 'boolean', default: false, description: 'Whether to download binary attachments into execution data' },
    ],
    knownTraps: [
      'Google/Gmail/v2/GmailV2.node.js:315-321: simple=false fetches raw base64 MIME string and runs mailparser simpleParser',
      'Google/Gmail/GenericFunctions.js:120-128: attachments are downloaded to binary properties attachment_0, attachment_1 only when downloadAttachments is true',
      'Google/Gmail/GenericFunctions.js:113-145: text, html, to, from, subject fields in mailparser output are populated only if present in message payload',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Gmail/GenericFunctions.js',
      hash: 'source-verified-GmailV2-parseRawEmail:113-145',
    },
    maturity: 'offline-source-verified',
  });

  // gmail@2.1 (send)
  index.registerCard({
    nodeType: 'n8n-nodes-base.gmail',
    version: 2.1,
    operation: 'send',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {
        id: 'string',
        threadId: 'string',
        labelIds: 'array',
      },
      shape: 'api-passthrough',
    },
    timezoneDependency: false,
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: '={{ $parameter.sendTo }}',
      subject: '={{ $parameter.subject }}',
      emailType: 'html',
      message: '={{ $parameter.message }}',
    },
    setupParameters: [
      { name: 'sendTo', type: 'string', required: true, description: 'Comma-separated recipient email addresses' },
      { name: 'subject', type: 'string', required: true, description: 'Email subject line' },
      { name: 'emailType', type: 'options', default: 'html', description: 'text or html body format' },
      { name: 'message', type: 'string', required: true, description: 'Email body content' },
    ],
    knownTraps: [
      'Google/Gmail/v2/GmailV2.node.js:253-258: returns raw Google API send response (id, threadId, labelIds)',
      'Google/Gmail/GenericFunctions.js:282-299: prepareEmailsInput validates presence of @ in every address before sending, throwing NodeOperationError if invalid',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Gmail/v2/GmailV2.node.js',
      hash: 'source-verified-GmailV2-send:240-260',
    },
    maturity: 'offline-source-verified',
  });

  // googleCalendar@1.3 (event:getAll)
  index.registerCard({
    nodeType: 'n8n-nodes-base.googleCalendar',
    version: 1.3,
    operation: 'getAll',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {
        id: 'string',
        summary: 'string|absent',
        start: 'object',
        end: 'object',
        attendees: 'array|absent',
        creator: 'object|absent',
        organizer: 'object|absent',
        description: 'string|absent',
        location: 'string|absent',
        created: 'string|absent',
        updated: 'string|absent',
      },
      shape: 'sorted-priority-list',
    },
    timezoneDependency: true,
    parameters: {
      resource: 'event',
      operation: 'getAll',
      calendar: { mode: 'list', value: '' },
      returnAll: false,
      limit: 50,
      options: {},
    },
    setupParameters: [
      { name: 'calendar', type: 'resourceLocator', required: true, description: 'Google Calendar ID or name' },
      { name: 'returnAll', type: 'boolean', default: false, description: 'Whether to return all events' },
      { name: 'limit', type: 'number', default: 50, displayOptions: { returnAll: [false] }, description: 'Max events count' },
      { name: 'options.timeZone', type: 'options', required: false, description: 'Timezone for formatting event dates (defaults to workflow timezone)' },
    ],
    knownTraps: [
      'Google/Calendar/GoogleCalendar.node.js:636-638: version >= 1.3 sorts item keys by priority list [id, summary, start, end, attendees, creator, organizer, description, location, created, updated]',
      'Google/Calendar/GoogleCalendar.node.js:345-357: version >= 1.3 defaults singleEvents = true to expand recurring events',
      'Google/Calendar/GoogleCalendar.node.js:447-455: warns in execution hints if recurring events repeat far into future without timeMax',
      'Google/Calendar/GoogleCalendar.node.js:622-638: summary, attendees, creator, organizer, description, location, created, updated are optional in Calendar API events (present only when defined)',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Calendar/GoogleCalendar.node.js',
      hash: 'source-verified-GoogleCalendar-getAll:338-455',
    },
    maturity: 'offline-source-verified',
  });

  // googleCalendar@1.3 (event:create)
  index.registerCard({
    nodeType: 'n8n-nodes-base.googleCalendar',
    version: 1.3,
    operation: 'create',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {
        id: 'string',
        summary: 'string|absent',
        start: 'object',
        end: 'object',
        attendees: 'array|absent',
        creator: 'object|absent',
        organizer: 'object|absent',
        description: 'string|absent',
        location: 'string|absent',
        created: 'string|absent',
        updated: 'string|absent',
      },
      shape: 'api-passthrough',
    },
    timezoneDependency: true,
    parameters: {
      resource: 'event',
      operation: 'create',
      calendar: { mode: 'list', value: '' },
      start: '={{ $parameter.start }}',
      end: '={{ $parameter.end }}',
      additionalFields: {},
    },
    setupParameters: [
      { name: 'calendar', type: 'resourceLocator', required: true, description: 'Target Google Calendar ID' },
      { name: 'start', type: 'dateTime', required: true, description: 'Start time of the event' },
      { name: 'end', type: 'dateTime', required: true, description: 'End time of the event' },
      { name: 'additionalFields.summary', type: 'string', description: 'Event title' },
      { name: 'additionalFields.allday', type: 'options', description: 'Whether event is all day (yes/no)' },
    ],
    knownTraps: [
      'Google/Calendar/GoogleCalendar.node.js:296-297: returns raw Google API create event response directly (api-passthrough)',
      'Google/Calendar/GoogleCalendar.node.js:262-264: throws error if both repeatHowManyTimes and repeatUntil are set',
      'Google/Calendar/GoogleCalendar.node.js:243-250: allday === "yes" forces date format to YYYY-MM-DD instead of dateTime timestamp',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Calendar/GoogleCalendar.node.js',
      hash: 'source-verified-GoogleCalendar-create:180-297',
    },
    maturity: 'offline-source-verified',
  });

  // googleDrive@3 (fileFolder:search)
  index.registerCard({
    nodeType: 'n8n-nodes-base.googleDrive',
    version: 3,
    operation: 'search',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {
        kind: 'string',
        id: 'string',
        name: 'string',
        mimeType: 'string',
      },
      shape: 'api-passthrough',
    },
    timezoneDependency: false,
    parameters: {
      resource: 'fileFolder',
      operation: 'search',
      searchMethod: 'name',
      queryString: '={{ $parameter.queryString }}',
      filter: {},
      options: {},
    },
    setupParameters: [
      { name: 'searchMethod', type: 'options', required: true, default: 'name', description: 'Search by file name or raw query string' },
      { name: 'queryString', type: 'string', required: true, description: 'Name to search for or query expression' },
      { name: 'filter.driveId', type: 'resourceLocator', required: false, description: 'Target shared drive (default: My Drive)' },
      { name: 'filter.folderId', type: 'resourceLocator', required: false, description: 'Target folder ID (default: root)' },
    ],
    knownTraps: [
      'Google/Drive/v2/actions/fileFolder/search.operation.js:315-320: if no driveId and folderId is root, sets corpora = "user" and spaces = "drive"',
      'Google/Drive/v2/actions/fileFolder/search.operation.js:321-330: returnAll=true calls googleApiRequestAllItems; otherwise fetches up to limit (pageSize)',
      'Google/Drive/v2/actions/fileFolder/search.operation.js:331-332: outputs raw files array via constructExecutionMetaData (api-passthrough)',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Google/Drive/v2/actions/fileFolder/search.operation.js',
      hash: 'source-verified-GoogleDriveV2-search:305-333',
    },
    maturity: 'offline-source-verified',
  });

  // filter@2.2 (conditions)
  index.registerCard({
    nodeType: 'n8n-nodes-base.filter',
    version: 2.2,
    operation: 'conditions',
    fixtureFamily: 'json-records',
    inputContract: { cardinality: 'items', fields: {} },
    outputContract: {
      cardinality: 'items',
      fields: {},
      shape: 'input-passthrough',
    },
    timezoneDependency: false,
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
        },
        conditions: [],
        combinator: 'and',
      },
      options: {
        ignoreCase: false,
        looseTypeValidation: false,
      },
    },
    setupParameters: [
      { name: 'conditions.conditions', type: 'filter', required: true, description: 'Rules evaluated per item; matching items emitted to kept (output 0), non-matching to discarded (output 1)' },
      { name: 'conditions.combinator', type: 'options', default: 'and', description: 'Logical combinator (and / or) across condition rules' },
      { name: 'options.ignoreCase', type: 'boolean', default: true, description: 'Whether to ignore letter case in string comparisons' },
      { name: 'options.looseTypeValidation', type: 'boolean', default: false, description: 'Less strict type checking on evaluated inputs' },
    ],
    connectableOutputs: 1,
    knownTraps: [
      'Filter/V2/FilterV2.node.js:23: only port 0 (Kept) is connectable (FilterV2.node.js:23 declares one main output; route3 arity = 1)',
      'Filter/V2/FilterV2.node.js:101-106: non-matching items appear in run data as output 1 (Discarded, :126) but cannot be wired',
      'If both branches are needed, use IF',
      'Filter/V2/FilterV2.node.js:35: caseSensitive condition option is dynamically bound to ={{!$parameter.options.ignoreCase}}, defaulting to case-sensitive when ignoreCase: false',
      'Filter/V2/FilterV2.node.js:89-97: strict typeValidation throws error on type mismatch unless looseTypeValidation is explicitly enabled',
      'Filter/V2/FilterV2.node.js:98-100: pairs input items preserving itemIndex mapping in item.pairedItem',
    ],
    evidence: {
      ref: 'n8n-node-catalog/raw/nodes/Filter/V2/FilterV2.node.js',
      hash: 'source-verified-FilterV2:1-128',
    },
    maturity: 'offline-source-verified',
  });

  // 6. Ingest transform cards from opsweep
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
    connectableOutputs: card.connectableOutputs,
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
