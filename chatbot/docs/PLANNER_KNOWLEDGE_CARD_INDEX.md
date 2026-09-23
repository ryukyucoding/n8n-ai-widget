# Planner Knowledge Card Index (CARD-INDEX M1)

**Component:** `chatbot/src/knowledgeCardIndex.js` & `chatbot/src/knowledgeCardLoader.js`  
**Purpose:** Provides an authoritative, queryable, offline knowledge repository of n8n node behaviors, contracts, traps, and evidence for planner synthesis (e.g. Compass).

---

## 1. Artifact Source & Configurable Base Path

The loader reads from verified offline engine artifacts published under `a2a/runner/e2_offline_engine/`:
- `behaviour-cards.json` (SHA256: `5f004543c0aafc6785c097dce1755e279e9229cdce005e5e97b5e0da162359c1`)
- `eprobes-report.json` (SHA256: `e5aa5552d58fef6dcd602f56388d6d88ee5eaa99f767911b01e7ad4f7f3372c5`)
- `opsweep-cards.json` (SHA256: `f887dcf35b349b19fdb5d20b1b2fe975be807e827fd1dd45351473482c2c3aa0`)
- Keystone K2 input-binding synthesis pilot results (`KEYSTONE_K2_INPUT_BINDING_PILOT_RESULT_20260923.md`)

### Configurable Base Path Resolution Order
1. Explicit argument in `createPopulatedPlannerCardIndex({ baseDir: '/path/to/artifacts' })`
2. Environment variable: `PLANNER_CARD_DIR`
3. Default checkout path: `../../../n8n-ai-widget-a2a-private/a2a/runner/e2_offline_engine`

**Fail-Closed Behavior:** If the target directory or any required artifact file is missing, unreadable, or corrupted, the loader throws immediately (`fail-closed`). It never silently drops cards or falls back to partial data.

---

## 2. Ingested Cards & Exact Count Guarantee

- **Exact Total Cards:** **60**
  - Curated Behaviour Cards: 5 (XML, htmlExtract, compression, etc.)
  - E-Probe Findings: 1 (E4 summarize naming)
  - K2 Input Binding Discoveries: 2 (`formatDate` UTC trap, `extractDate` numeric output type)
  - Demo 3 M1 Expanded Node Cards: 7
    * `if@2.2#conditions` (filter version 2, strict validation, output routing, file:line citations)
    * `switch@3.4#rules` (fallbackOutput extra channel routing)
    * `merge@3#append` (sequential input array concatenation)
    * `merge@3#combineByFields` (fieldsToMatchString vs mergeByFields advanced selector)
    * `googleSheets@4.7#read` (combineFilters version switch, loop over items, untilSheetSelected)
    * `gmail@2.1#getAll` (returnAll vs limit, simple MIME toggle, filter options)
    * `slack@2.2#post` (select channel vs user RLC, messageType text vs blocksUi, thread_ts)
  - Opsweep Transform Cards: 45

---

## 3. Query Entrypoint for Planner (Compass)

Planners can query the card index either in-memory or via helper:

```javascript
const { queryKnowledgeCard } = require('./knowledgeCardLoader');

// Query by full key
const card = queryKnowledgeCard('n8n-nodes-base.dateTime@2#formatDate');

// Or by nodeType and operation
const extractCard = queryKnowledgeCard('n8n-nodes-base.dateTime@2', 'extractDate');

/*
Output structure:
{
  key: 'n8n-nodes-base.dateTime@2#formatDate',
  nodeType: 'n8n-nodes-base.dateTime',
  version: 2,
  operation: 'formatDate',
  fixtureFamily: 'typed-orders-dates',
  inputContract: { cardinality: 'items', fields: { createdAt: 'string' } },
  outputContract: { cardinality: 'items', fields: { formattedDate: 'string' } },
  timezoneDependency: true,
  knownTraps: [
    'formatDate ignores workflow timezone by default and formats as UTC unless options.timezone is set',
    ...
  ],
  evidence: {
    ref: 'a2a/results/KEYSTONE_K2_INPUT_BINDING_PILOT_RESULT_20260923.md §3',
    hash: '523be42fb8c7cc2809d6d86aaf21073b678c60cfc3358976ac1da05556718c86'
  },
  maturity: 'offline-engine-verified (source confirmed DateTimeV2.node.js:137)'
}
*/
```
