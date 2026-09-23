'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { KnowledgeCardIndex } = require('../src/knowledgeCardIndex');
const {
  createPopulatedPlannerCardIndex,
  queryKnowledgeCard,
  ARTIFACT_MANIFESTS,
  EXACT_TOTAL_CARDS,
  sha256File,
} = require('../src/knowledgeCardLoader');

console.log('--- Testing CARD-INDEX M1 Hardening Suite ---');

// 1. Ingest published artifacts and verify exact count
const index = createPopulatedPlannerCardIndex();
const totalCards = index.count();
console.log(`Ingested exactly ${totalCards} knowledge cards.`);
assert.strictEqual(totalCards, EXACT_TOTAL_CARDS, `Expected exactly ${EXACT_TOTAL_CARDS} cards`);
console.log('Test 1 (Exact card count 54 verified): PASS');

// 2. Verify artifact manifest hashes against published files
const baseDir = path.resolve(__dirname, '../../../n8n-ai-widget-a2a-private/a2a/runner/e2_offline_engine');
for (const [filename, manifest] of Object.entries(ARTIFACT_MANIFESTS)) {
  const filePath = path.join(baseDir, filename);
  const hash = sha256File(filePath);
  assert.strictEqual(hash, manifest.sha256, `SHA256 mismatch for ${filename}`);
}
console.log('Test 2 (Artifact manifest SHA256 hashes bound and verified): PASS');

// 3. Fail closed on missing artifact directory
assert.throws(
  () => createPopulatedPlannerCardIndex({ baseDir: '/nonexistent/path/for/test' }),
  /Artifact directory does not exist/,
  'Expected missing artifact directory to fail closed'
);
console.log('Test 3 (Missing artifact directory throws fail-closed): PASS');

// 4. Fail closed on missing required artifact file
assert.throws(
  () => createPopulatedPlannerCardIndex({ behaviourCards: '/nonexistent/behaviour-cards.json' }),
  /Required artifact file is missing/,
  'Expected missing artifact file to fail closed'
);
console.log('Test 4 (Missing required artifact file throws fail-closed): PASS');

// 5. Configurable path via custom options works cleanly
const customIndex = createPopulatedPlannerCardIndex({ baseDir: baseDir });
assert.strictEqual(customIndex.count(), EXACT_TOTAL_CARDS);
console.log('Test 5 (Configurable base directory via options works cleanly): PASS');

// 6. Configurable path via env PLANNER_CARD_DIR works cleanly
process.env.PLANNER_CARD_DIR = baseDir;
const envIndex = createPopulatedPlannerCardIndex();
assert.strictEqual(envIndex.count(), EXACT_TOTAL_CARDS);
delete process.env.PLANNER_CARD_DIR;
console.log('Test 6 (Configurable base directory via PLANNER_CARD_DIR works cleanly): PASS');

// 7. Query entrypoint queryKnowledgeCard by full key
const cardByKey = queryKnowledgeCard('n8n-nodes-base.dateTime@2#formatDate');
assert.ok(cardByKey, 'cardByKey must exist');
assert.strictEqual(cardByKey.timezoneDependency, true);
assert.ok(cardByKey.knownTraps.some((t) => t.includes('formatDate ignores workflow timezone by default')));
assert.strictEqual(cardByKey.evidence.ref, 'a2a/results/KEYSTONE_K2_INPUT_BINDING_PILOT_RESULT_20260923.md §3');
console.log('Test 7 (Query entrypoint queryKnowledgeCard by key verified): PASS');

// 8. Query entrypoint queryKnowledgeCard by nodeType and operation
const cardByNodeOp = queryKnowledgeCard('n8n-nodes-base.dateTime@2', 'extractDate');
assert.ok(cardByNodeOp, 'cardByNodeOp must exist');
assert.strictEqual(cardByNodeOp.outputContract.fields.datePart, 'number');
assert.ok(cardByNodeOp.knownTraps.some((t) => t.includes('output field type is number, not string')));
console.log('Test 8 (Query entrypoint queryKnowledgeCard by nodeType and operation verified): PASS');

// 9. Query non-existent card returns null cleanly
const nonExistent = queryKnowledgeCard('n8n-nodes-base.nonExistent@1#op');
assert.strictEqual(nonExistent, null, 'Expected non-existent card to return null');
console.log('Test 9 (Query non-existent card returns null cleanly): PASS');

// 10. Query entrypoint immutability: returned object cannot mutate index state
cardByKey.knownTraps.push('tampered trap');
const freshCard = queryKnowledgeCard('n8n-nodes-base.dateTime@2#formatDate');
assert.ok(!freshCard.knownTraps.includes('tampered trap'), 'Returned card must not allow state tampering');
console.log('Test 10 (Query entrypoint immutability verified): PASS');

console.log('ALL CARD-INDEX M1 HARDENING TESTS PASS (100% verified)');
