'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { KnowledgeCardIndex } = require('../src/knowledgeCardIndex');
const {
  createPopulatedPlannerCardIndex,
  queryKnowledgeCard,
  ARTIFACT_MANIFESTS,
  EXACT_TOTAL_CARDS,
  sha256File,
} = require('../src/knowledgeCardLoader');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');

console.log('--- Testing CARD-INDEX M1, Demo 3 & Demo 4 Google-Family Suite ---');

// 1. Ingest published artifacts and verify exact count
const index = createPopulatedPlannerCardIndex();
const totalCards = index.count();
console.log(`Ingested exactly ${totalCards} knowledge cards.`);
assert.strictEqual(totalCards, EXACT_TOTAL_CARDS, `Expected exactly ${EXACT_TOTAL_CARDS} cards`);
assert.strictEqual(totalCards, 68, 'Card count must be exactly 68');
console.log('Test 1 (Exact card count 68 verified): PASS');

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

// 11. Demo 4 Card: googleSheets read@4.7 (unified read-all and lookup)
const sheetsReadCard = queryKnowledgeCard('n8n-nodes-base.googleSheets@4.7#read');
assert.ok(sheetsReadCard, 'googleSheets@4.7#read must exist');
assert.strictEqual(sheetsReadCard.version, 4.7);
assert.strictEqual(sheetsReadCard.outputContract.fields.row_number, 'number');
assert.strictEqual(sheetsReadCard.outputContract.shape, 'user-sheet-dependent');
assert.ok(sheetsReadCard.knownTraps.some((t) => t.includes('Google/Sheet/v2/actions/sheet/read.operation.js:166-168')));
assert.ok(sheetsReadCard.knownTraps.some((t) => t.includes('Google/Sheet/v2/helpers/GoogleSheet.js:392-474')));
console.log('Test 11 (Demo 4 googleSheets read@4.7 unified card verified): PASS');

// 12. Reachability Test: Verify all registered Demo 4 operations exist in catalog schema
const reachabilityTargets = [
  { nodeType: 'n8n-nodes-base.googleSheets', version: 4.7, resource: 'sheet', operation: 'read' },
  { nodeType: 'n8n-nodes-base.googleSheets', version: 4.7, resource: 'sheet', operation: 'append' },
  { nodeType: 'n8n-nodes-base.googleSheets', version: 4.7, resource: 'sheet', operation: 'update' },
  { nodeType: 'n8n-nodes-base.gmail', version: 2.1, resource: 'message', operation: 'getAll' },
  { nodeType: 'n8n-nodes-base.gmail', version: 2.1, resource: 'message', operation: 'send' },
  { nodeType: 'n8n-nodes-base.googleCalendar', version: 1.3, resource: 'event', operation: 'getAll' },
  { nodeType: 'n8n-nodes-base.googleCalendar', version: 1.3, resource: 'event', operation: 'create' },
  { nodeType: 'n8n-nodes-base.googleDrive', version: 3, resource: 'fileFolder', operation: 'search' },
];

for (const target of reachabilityTargets) {
  const versionNode = runtimeSchemas.nodeTypes[target.nodeType]?.versions[String(target.version)];
  assert.ok(versionNode, `Node ${target.nodeType}@${target.version} must exist in runtime catalog`);
  const opProps = versionNode.properties.filter((p) => p.name === 'operation' && (!p.displayOptions?.show?.resource || p.displayOptions.show.resource.includes(target.resource)));
  const validOps = opProps.flatMap((p) => (p.options || []).map((o) => o.value));
  assert.ok(validOps.includes(target.operation), `Operation ${target.operation} must exist in catalog for ${target.nodeType}@${target.version}`);
}
console.log('Test 12 (Catalog reachability: all operations exist in catalog options): PASS');

// 13. Demo 4 Card: googleSheets append@4.7 (input passthrough shape)
const sheetsAppendCard = queryKnowledgeCard('n8n-nodes-base.googleSheets@4.7#append');
assert.ok(sheetsAppendCard, 'googleSheets@4.7#append must exist');
assert.strictEqual(sheetsAppendCard.outputContract.shape, 'input-passthrough');
assert.ok(sheetsAppendCard.knownTraps.some((t) => t.includes('Google/Sheet/v2/actions/sheet/append.operation.js:253-258')));
console.log('Test 13 (Demo 4 googleSheets append@4.7 card verified): PASS');

// 14. Demo 4 Card: googleSheets update@4.7 (input passthrough, row_number index)
const sheetsUpdateCard = queryKnowledgeCard('n8n-nodes-base.googleSheets@4.7#update');
assert.ok(sheetsUpdateCard, 'googleSheets@4.7#update must exist');
assert.strictEqual(sheetsUpdateCard.outputContract.shape, 'input-passthrough');
assert.ok(sheetsUpdateCard.knownTraps.some((t) => t.includes('Google/Sheet/v2/actions/sheet/update.operation.js:377-379')));
console.log('Test 14 (Demo 4 googleSheets update@4.7 card verified): PASS');

// 15. Demo 4 Card: gmail getAll@2.1 (simple=true with string|absent) vs getAllRaw@2.1 (simple=false)
const gmailSimpleCard = queryKnowledgeCard('n8n-nodes-base.gmail@2.1#getAll');
assert.ok(gmailSimpleCard, 'gmail@2.1#getAll must exist');
assert.strictEqual(gmailSimpleCard.outputContract.shape, 'fixed-simple-metadata');
assert.strictEqual(gmailSimpleCard.outputContract.fields.snippet, 'string');
assert.strictEqual(gmailSimpleCard.outputContract.fields.Cc, 'string|absent');
assert.strictEqual(gmailSimpleCard.outputContract.fields.Bcc, 'string|absent');

const gmailRawCard = queryKnowledgeCard('n8n-nodes-base.gmail@2.1#getAllRaw');
assert.ok(gmailRawCard, 'gmail@2.1#getAllRaw must exist');
assert.strictEqual(gmailRawCard.outputContract.shape, 'mailparser-parsed');
assert.strictEqual(gmailRawCard.outputContract.fields.html, 'string|absent');
assert.strictEqual(gmailRawCard.outputContract.fields.sizeEstimate, 'number');
console.log('Test 15 (Demo 4 gmail simple=true with string|absent and simple=false verified): PASS');

// 16. Demo 4 Card: gmail send@2.1
const gmailSendCard = queryKnowledgeCard('n8n-nodes-base.gmail@2.1#send');
assert.ok(gmailSendCard, 'gmail@2.1#send must exist');
assert.strictEqual(gmailSendCard.outputContract.shape, 'api-passthrough');
assert.strictEqual(gmailSendCard.outputContract.fields.id, 'string');
assert.ok(gmailSendCard.knownTraps.some((t) => t.includes('prepareEmailsInput validates presence of @')));
console.log('Test 16 (Demo 4 gmail send@2.1 card verified): PASS');

// 17. Demo 4 Card: googleCalendar event:getAll@1.3 and create@1.3 (api-passthrough)
const calGetAllCard = queryKnowledgeCard('n8n-nodes-base.googleCalendar@1.3#getAll');
assert.ok(calGetAllCard, 'googleCalendar@1.3#getAll must exist');
assert.strictEqual(calGetAllCard.timezoneDependency, true);
assert.strictEqual(calGetAllCard.outputContract.shape, 'sorted-priority-list');
assert.strictEqual(calGetAllCard.outputContract.fields.summary, 'string|absent');

const calCreateCard = queryKnowledgeCard('n8n-nodes-base.googleCalendar@1.3#create');
assert.ok(calCreateCard, 'googleCalendar@1.3#create must exist');
assert.strictEqual(calCreateCard.timezoneDependency, true);
assert.strictEqual(calCreateCard.outputContract.shape, 'api-passthrough');
assert.ok(calCreateCard.knownTraps.some((t) => t.includes('repeatHowManyTimes and repeatUntil')));
console.log('Test 17 (Demo 4 googleCalendar getAll and create api-passthrough verified): PASS');

// 18. Demo 4 Card: googleDrive fileFolder:search@3 (api-passthrough)
const driveSearchCard = queryKnowledgeCard('n8n-nodes-base.googleDrive@3#search');
assert.ok(driveSearchCard, 'googleDrive@3#search must exist');
assert.strictEqual(driveSearchCard.version, 3);
assert.strictEqual(driveSearchCard.outputContract.shape, 'api-passthrough');
assert.strictEqual(driveSearchCard.outputContract.fields.mimeType, 'string');
console.log('Test 18 (Demo 4 googleDrive search card verified): PASS');

// 19. Demo 4 Machine-readable pinned-shapes.json validation (route v3.8.4 format)
const pinnedShapesPath = path.resolve(__dirname, '../src/pinned-shapes.json');
assert.ok(fs.existsSync(pinnedShapesPath), 'pinned-shapes.json must exist');
const pinnedData = JSON.parse(fs.readFileSync(pinnedShapesPath, 'utf8'));
assert.ok(pinnedData && Array.isArray(pinnedData.shapes), 'pinned-shapes must have a shapes array');
assert.strictEqual(pinnedData.shapes.length, 9, 'Expected exactly 9 pinned shape definitions after readLookup merge');

for (const entry of pinnedData.shapes) {
  assert.ok(entry.type && entry.type.startsWith('n8n-nodes-base.'));
  assert.ok(entry.typeVersion > 0);
  assert.ok(entry.resource);
  assert.ok(entry.operation);
  assert.ok(entry.fields && typeof entry.fields === 'object');
  assert.ok(entry.when && typeof entry.when === 'object');
  assert.ok(Array.isArray(entry.citations) && entry.citations.length > 0);
}
console.log('Test 19 (pinned-shapes.json route v3.8.4 schema and citations verified): PASS');

// 20. Query entrypoint immutability: returned card cannot mutate index state
ifCard.knownTraps.push('tampered trap');
const freshCard = queryKnowledgeCard('n8n-nodes-base.if@2.2#conditions');
assert.ok(!freshCard.knownTraps.includes('tampered trap'), 'Returned card must not allow state tampering');
console.log('Test 20 (Query entrypoint immutability verified): PASS');

// 21. E1 Card: filter@2.2 (kept vs discarded output, conditions, source traps)
const filterCard = queryKnowledgeCard('n8n-nodes-base.filter@2.2#conditions');
assert.ok(filterCard, 'filter@2.2#conditions must exist');
assert.strictEqual(filterCard.version, 2.2);
assert.strictEqual(filterCard.outputContract.shape, 'input-passthrough');
assert.ok(filterCard.knownTraps.some((t) => t.includes('Filter/V2/FilterV2.node.js:101-106')));
assert.ok(filterCard.knownTraps.some((t) => t.includes('Filter/V2/FilterV2.node.js:35')));
assert.ok(filterCard.setupParameters.some((p) => p.name === 'conditions.conditions'));
console.log('Test 21 (E1 filter@2.2 card with source-cited traps verified): PASS');

console.log('ALL CARD-INDEX M1, DEMO 3, DEMO 4 & E1 FILTER TESTS PASS (100% verified)');
