'use strict';

const assert = require('node:assert');
const { KnowledgeCardIndex } = require('../src/knowledgeCardIndex');
const { createPopulatedPlannerCardIndex } = require('../src/knowledgeCardLoader');

console.log('--- Testing KnowledgeCardIndex and Planner Artifact Ingestion Suite ---');

// 1. Ingest published artifacts into the card index
const index = createPopulatedPlannerCardIndex();
const totalCards = index.count();
console.log(`Ingested ${totalCards} knowledge cards from published artifacts.`);
assert.ok(totalCards > 10, 'Expected at least 10 cards ingested');
console.log('Test 1 (Ingestion from published behaviour-cards, eprobes, K2, opsweep): PASS');

// 2. Query exact node@version#operation key
const xmlCard = index.get('n8n-nodes-base.xml@1#xmlToJson');
assert.ok(xmlCard, 'xml@1#xmlToJson card must exist');
assert.strictEqual(xmlCard.nodeType, 'n8n-nodes-base.xml');
assert.strictEqual(xmlCard.version, 1);
assert.strictEqual(xmlCard.operation, 'xmlToJson');
assert.strictEqual(xmlCard.fixtureFamily, 'text-xml');
assert.ok(xmlCard.knownTraps.some((t) => t.includes('Item has no JSON property called "doc"')));
console.log('Test 2 (Exact key lookup n8n-nodes-base.xml@1#xmlToJson with traps): PASS');

// 3. Query K2 input-binding synthesis discovery: formatDate timezone trap
const formatDateCard = index.get('n8n-nodes-base.dateTime@2#formatDate');
assert.ok(formatDateCard, 'dateTime@2#formatDate card must exist');
assert.strictEqual(formatDateCard.timezoneDependency, true);
assert.ok(
  formatDateCard.knownTraps.some((t) => t.includes('formatDate ignores workflow timezone by default and formats as UTC')),
  'formatDate must record timezone trap'
);
assert.strictEqual(
  formatDateCard.evidence.ref,
  'a2a/results/KEYSTONE_K2_INPUT_BINDING_PILOT_RESULT_20260923.md §3'
);
console.log('Test 3 (K2 formatDate timezone trap and evidence ref verified): PASS');

// 4. Query extractDate card: output type number and includeInputFields trap
const extractDateCard = index.get('n8n-nodes-base.dateTime@2#extractDate');
assert.ok(extractDateCard, 'dateTime@2#extractDate card must exist');
assert.strictEqual(extractDateCard.outputContract.fields.datePart, 'number');
assert.ok(
  extractDateCard.knownTraps.some((t) => t.includes('output field type is number, not string')),
  'extractDate must record number output type trap'
);
console.log('Test 4 (extractDate numeric output contract and traps verified): PASS');

// 5. Query e-probe E4: summarize sum_<field> and count_<field>
const summarizeCard = index.get('n8n-nodes-base.summarize@1.1#summarize');
assert.ok(summarizeCard, 'summarize card must exist');
assert.ok(summarizeCard.knownTraps.some((t) => t.includes('sum output field is named sum_<field>')));
console.log('Test 5 (E-probe E4 summarize naming trap verified): PASS');

// 6. Query by filter: timezone-dependent cards
const tzCards = index.query({ timezoneDependency: true });
assert.ok(tzCards.length >= 2, 'Expected at least 2 timezone-dependent cards');
assert.ok(tzCards.every((c) => c.nodeType === 'n8n-nodes-base.dateTime'));
console.log('Test 6 (Query by filter timezoneDependency: true): PASS');

// 7. Query by filter: nodeType and version
const xmlCards = index.query({ nodeType: 'n8n-nodes-base.xml', version: 1 });
assert.ok(xmlCards.length >= 1);
console.log('Test 7 (Query by nodeType and version): PASS');

// 8. Strict validation: registering card with missing required fields fails closed
const invalidCard = {
  nodeType: 'n8n-nodes-base.code',
  version: 2,
  // missing operation, fixtureFamily, etc.
};
assert.throws(
  () => index.registerCard(invalidCard),
  /Card missing required field/,
  'Expected card with missing required fields to fail closed'
);
console.log('Test 8 (Card shape schema validation fails closed): PASS');

// 9. Duplicate card registration fails closed
assert.throws(
  () => index.registerCard(xmlCard),
  /Duplicate card key registered/,
  'Expected duplicate card key to fail closed'
);
console.log('Test 9 (Duplicate card key registration fails closed): PASS');

// 10. Immutability: registered card is frozen
assert.ok(Object.isFrozen(xmlCard), 'Registered card must be Object.freeze-d');
console.log('Test 10 (Registered card immutability verified): PASS');

console.log('ALL KNOWLEDGE CARD INDEX TESTS PASS (100% verified)');
