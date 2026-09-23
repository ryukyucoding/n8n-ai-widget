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

console.log('--- Testing CARD-INDEX M1 & Demo 3 Coverage Suite ---');

// 1. Ingest published artifacts and verify exact count
const index = createPopulatedPlannerCardIndex();
const totalCards = index.count();
console.log(`Ingested exactly ${totalCards} knowledge cards.`);
assert.strictEqual(totalCards, EXACT_TOTAL_CARDS, `Expected exactly ${EXACT_TOTAL_CARDS} cards`);
assert.strictEqual(totalCards, 60, 'Card count must be exactly 60');
console.log('Test 1 (Exact card count 60 verified): PASS');

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

// 7. Demo 3 Card: if@2.2 with conditions and source-cited traps
const ifCard = queryKnowledgeCard('n8n-nodes-base.if@2.2#conditions');
assert.ok(ifCard, 'if@2.2#conditions must exist');
assert.strictEqual(ifCard.version, 2.2);
assert.ok(ifCard.knownTraps.some((t) => t.includes('IfV2.node.js:44')));
assert.ok(ifCard.knownTraps.some((t) => t.includes('IfV2.node.js:108-114')));
assert.ok(ifCard.setupParameters.some((p) => p.name === 'conditions.conditions'));
console.log('Test 7 (Demo 3 if@2.2 card with source citations verified): PASS');

// 8. Demo 3 Card: switch@3.4 with rules and fallbackOutput
const switchCard = queryKnowledgeCard('n8n-nodes-base.switch@3.4#rules');
assert.ok(switchCard, 'switch@3.4#rules must exist');
assert.strictEqual(switchCard.version, 3.4);
assert.ok(switchCard.knownTraps.some((t) => t.includes('SwitchV3.node.js:29-35')));
assert.ok(switchCard.setupParameters.some((p) => p.name === 'rules.values'));
console.log('Test 8 (Demo 3 switch@3.4 card with fallbackOutput trap verified): PASS');

// 9. Demo 3 Card: merge@3 append mode
const mergeAppendCard = queryKnowledgeCard('n8n-nodes-base.merge@3#append');
assert.ok(mergeAppendCard, 'merge@3#append must exist');
assert.strictEqual(mergeAppendCard.version, 3);
assert.ok(mergeAppendCard.knownTraps.some((t) => t.includes('Merge/v3/actions/mode/append.js:14-19')));
console.log('Test 9 (Demo 3 merge@3#append card verified): PASS');

// 10. Demo 3 Card: merge@3 combineByFields mode with multipleMatches
const mergeCombineCard = queryKnowledgeCard('n8n-nodes-base.merge@3#combineByFields');
assert.ok(mergeCombineCard, 'merge@3#combineByFields must exist');
assert.strictEqual(mergeCombineCard.version, 3);
assert.ok(mergeCombineCard.knownTraps.some((t) => t.includes('Merge/v3/actions/mode/combineByFields.js:28-48')));
assert.ok(mergeCombineCard.setupParameters.some((p) => p.name === 'fieldsToMatchString'));
console.log('Test 10 (Demo 3 merge@3#combineByFields card verified): PASS');

// 11. Demo 3 Card: googleSheets read@4.7 with setup parameters and traps
const sheetsCard = queryKnowledgeCard('n8n-nodes-base.googleSheets@4.7#read');
assert.ok(sheetsCard, 'googleSheets@4.7#read must exist');
assert.strictEqual(sheetsCard.version, 4.7);
assert.ok(sheetsCard.knownTraps.some((t) => t.includes('Google/Sheet/v2/actions/sheet/read.operation.js:81-104')));
assert.ok(sheetsCard.setupParameters.some((p) => p.name === 'documentId'));
assert.ok(sheetsCard.setupParameters.some((p) => p.name === 'sheetName'));
console.log('Test 11 (Demo 3 googleSheets read@4.7 card verified): PASS');

// 12. Demo 3 Card: gmail getAll@2.1 with setup parameters and traps
const gmailCard = queryKnowledgeCard('n8n-nodes-base.gmail@2.1#getAll');
assert.ok(gmailCard, 'gmail@2.1#getAll must exist');
assert.strictEqual(gmailCard.version, 2.1);
assert.ok(gmailCard.knownTraps.some((t) => t.includes('Google/Gmail/v2/MessageDescription.js:347-363')));
assert.ok(gmailCard.setupParameters.some((p) => p.name === 'returnAll'));
console.log('Test 12 (Demo 3 gmail getAll@2.1 card verified): PASS');

// 13. Demo 3 Card: slack post@2.2 with channelRLC/userRLC setup parameters and traps
const slackCard = queryKnowledgeCard('n8n-nodes-base.slack@2.2#post');
assert.ok(slackCard, 'slack@2.2#post must exist');
assert.strictEqual(slackCard.version, 2.2);
assert.ok(slackCard.knownTraps.some((t) => t.includes('Slack/V2/MessageDescription.js:246-265')));
assert.ok(slackCard.setupParameters.some((p) => p.name === 'channelId'));
assert.ok(slackCard.setupParameters.some((p) => p.name === 'text'));
console.log('Test 13 (Demo 3 slack post@2.2 card verified): PASS');

// 14. Query entrypoint immutability: returned card cannot mutate index state
ifCard.knownTraps.push('tampered trap');
const freshCard = queryKnowledgeCard('n8n-nodes-base.if@2.2#conditions');
assert.ok(!freshCard.knownTraps.includes('tampered trap'), 'Returned card must not allow state tampering');
console.log('Test 14 (Query entrypoint immutability verified): PASS');

console.log('ALL CARD-INDEX M1 & DEMO 3 TESTS PASS (100% verified)');
