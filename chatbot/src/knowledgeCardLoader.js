'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KnowledgeCardIndex } = require('./knowledgeCardIndex');

/**
 * Builds and populates a KnowledgeCardIndex from verified published artifacts:
 * - behaviour-cards.json
 * - eprobes-report.json
 * - opsweep-cards.json
 * - K2 input binding pilot discoveries (formatDate UTC vs workflowTimezone trap)
 */

function createPopulatedPlannerCardIndex(customPaths = {}) {
  const index = new KnowledgeCardIndex();

  const basePath = customPaths.baseDir || path.resolve(__dirname, '../../../n8n-ai-widget-a2a-private/a2a/runner/e2_offline_engine');
  const behaviourCardsPath = customPaths.behaviourCards || path.join(basePath, 'behaviour-cards.json');
  const eprobesReportPath = customPaths.eprobesReport || path.join(basePath, 'eprobes-report.json');
  const opsweepCardsPath = customPaths.opsweepCards || path.join(basePath, 'opsweep-cards.json');

  // Ingest curated behaviour-cards
  if (fs.existsSync(behaviourCardsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(behaviourCardsPath, 'utf8'));
      if (Array.isArray(data.cards)) {
        for (const c of data.cards) {
          const parts = (c.card || '').split('#');
          const operation = parts[1] || c.parameters?.operation || c.parameters?.mode || 'default';
          const cardObj = {
            nodeType: c.type,
            version: c.typeVersion,
            operation: operation,
            fixtureFamily: c.fixtureFamily || 'unknown',
            inputContract: {
              cardinality: c.observations?.[0]?.cardinality === '1:1' ? 'items' : 'items',
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
      }
    } catch (e) {
      // Fail-closed on corrupted json
      throw new Error(`Failed to ingest behaviour-cards: ${e.message}`);
    }
  }

  // Ingest e-probe findings
  if (fs.existsSync(eprobesReportPath)) {
    try {
      const epData = JSON.parse(fs.readFileSync(eprobesReportPath, 'utf8'));
      if (Array.isArray(epData.results)) {
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
      }
    } catch (e) {
      throw new Error(`Failed to ingest eprobes: ${e.message}`);
    }
  }

  // Ingest K2 input-binding synthesis discovery (dateTime@2)
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

  // Ingest select transform cards from opsweep
  if (fs.existsSync(opsweepCardsPath)) {
    try {
      const opsData = JSON.parse(fs.readFileSync(opsweepCardsPath, 'utf8'));
      if (Array.isArray(opsData.nodes)) {
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
      }
    } catch (e) {
      throw new Error(`Failed to ingest opsweep-cards: ${e.message}`);
    }
  }

  return index;
}

module.exports = {
  createPopulatedPlannerCardIndex,
};
