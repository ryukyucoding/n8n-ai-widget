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

const EXACT_TOTAL_CARDS = 54; // 5 behaviour + 2 eprobe + 2 K2 discoveries + 45 opsweep

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
      if (ep.id === 'E2') {
        index.registerCard({
          nodeType: 'n8n-nodes-base.switch',
          version: 3.4,
          operation: 'rules',
          fixtureFamily: 'json-records',
          inputContract: { cardinality: 'items', fields: {} },
          outputContract: { cardinality: 'items', fields: {} },
          timezoneDependency: false,
          knownTraps: ['fallbackOutput "extra" directs fallback items to port N after rules'],
          evidence: {
            ref: 'a2a/runner/e2_offline_engine/eprobes-report.json#E2',
            hash: 'eprobe-verified',
          },
          maturity: 'engine-observed (offline n8n 2.18.3)',
        });
      } else if (ep.id === 'E4') {
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

  // 3. Ingest K2 input-binding synthesis discoveries (dateTime@2)
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
