'use strict';

const assert = require('node:assert');
const { compileNodewiseSpecification, validateSpecification } = require('../src/nodewiseCompiler');
const { getSkill } = require('../src/runtimeSkillRegistry');
const { defaultRegistry } = require('../src/catalogActionRegistry');
const { skillIdsForSpecification } = require('../src/approvedNodewiseCompiler');

console.log('--- Testing transform.xml_convert (n8n-nodes-base.xml@1) In-Repo Suite ---');

const baseSpec = {
  schemaVersion: '1.0',
  kind: 'nodewise_step_specification',
  goal: 'Test XML convert transform',
  requiredUserSetup: [],
  expectedOutput: { deliveryShape: 'one_object', fields: ['totalItems'] },
  steps: [
    { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
    {
      id: 'fetch-data',
      capability: 'http_request',
      requiredUserSetup: [],
      configuration: {
        method: 'GET',
        url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/todos', cardinality: 'items' },
      },
    },
    {
      id: 'xml-step',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'xml_convert',
        input: { kind: 'prior_step', reference: 'fetch-data.response', cardinality: 'items' },
        mode: 'xmlToJson',
        field: 'title',
        outputFieldName: 'jsonOutput',
      },
    },
    {
      id: 'count',
      capability: 'data_transform',
      requiredUserSetup: [],
      configuration: {
        operation: 'count_false_boolean',
        input: { kind: 'prior_step', reference: 'xml-step.response', cardinality: 'items' },
        field: 'completed',
        totalField: 'totalItems',
        falseCountField: 'incompleteItems',
      },
    },
    {
      id: 'output',
      capability: 'set_output',
      requiredUserSetup: [],
      configuration: {
        input: { kind: 'prior_step', reference: 'count.response', cardinality: 'one_object' },
        mappings: [{ from: 'totalItems', to: 'totalItems', valueType: 'number' }],
      },
    },
  ],
};

// 1. Test strictly pinned typeVersion: 1, node type, and parameters binding (xmlToJson)
// For xmlToJson, dataPropertyName carries config.field (the XML string property to parse)
const wfXmlToJson = compileNodewiseSpecification(baseSpec);
const xmlNode = wfXmlToJson.nodes[2];
assert.strictEqual(xmlNode.type, 'n8n-nodes-base.xml');
assert.strictEqual(xmlNode.typeVersion, 1);
assert.strictEqual(xmlNode.parameters.mode, 'xmlToJson');
assert.strictEqual(xmlNode.parameters.dataPropertyName, 'title');
assert.deepStrictEqual(xmlNode.parameters.options, {});
console.log('Test 1 (Pinned typeVersion: 1, exact parameters, closed options for xmlToJson): PASS');

// 2. Test mode jsonToxml parameter binding
// For jsonToxml, dataPropertyName carries config.outputFieldName (the target XML string property)
const jsonToXmlSpec = JSON.parse(JSON.stringify(baseSpec));
jsonToXmlSpec.steps[2].configuration.mode = 'jsonToxml';
jsonToXmlSpec.steps[2].configuration.outputFieldName = 'xmlOutput';
const wfJsonToXml = compileNodewiseSpecification(jsonToXmlSpec);
assert.strictEqual(wfJsonToXml.nodes[2].typeVersion, 1);
assert.strictEqual(wfJsonToXml.nodes[2].parameters.mode, 'jsonToxml');
assert.strictEqual(wfJsonToXml.nodes[2].parameters.dataPropertyName, 'xmlOutput');
assert.deepStrictEqual(wfJsonToXml.nodes[2].parameters.options, {});
console.log('Test 2 (Mode jsonToxml parameter binding): PASS');

// 3. Test default outputFieldName when omitted
const noOutputFieldXmlToJson = JSON.parse(JSON.stringify(baseSpec));
delete noOutputFieldXmlToJson.steps[2].configuration.outputFieldName;
const validatedXmlToJson = validateSpecification(noOutputFieldXmlToJson);
assert.strictEqual(validatedXmlToJson.steps[2].configuration.outputFieldName, 'jsonOutput');

const noOutputFieldJsonToXml = JSON.parse(JSON.stringify(baseSpec));
noOutputFieldJsonToXml.steps[2].configuration.mode = 'jsonToxml';
delete noOutputFieldJsonToXml.steps[2].configuration.outputFieldName;
const validatedJsonToXml = validateSpecification(noOutputFieldJsonToXml);
assert.strictEqual(validatedJsonToXml.steps[2].configuration.outputFieldName, 'xmlOutput');
const wfDefJsonToXml = compileNodewiseSpecification(noOutputFieldJsonToXml);
assert.strictEqual(wfDefJsonToXml.nodes[2].parameters.dataPropertyName, 'xmlOutput');
console.log('Test 3 (Default outputFieldName for xmlToJson and jsonToxml): PASS');

// 4. Test unsupported mode fails closed
const badModeSpec = JSON.parse(JSON.stringify(baseSpec));
badModeSpec.steps[2].configuration.mode = 'yamlToJson';
assert.throws(
  () => compileNodewiseSpecification(badModeSpec),
  /xml_convert mode must be jsonToxml or xmlToJson/,
  'Expected unsupported mode to fail closed'
);
console.log('Test 4 (Unsupported mode fails closed): PASS');

// 5. Test unknown / options property fails closed (options not planner-reachable)
const optionsAttemptSpec = JSON.parse(JSON.stringify(baseSpec));
optionsAttemptSpec.steps[2].configuration.options = { attrkey: '@' };
assert.throws(
  () => compileNodewiseSpecification(optionsAttemptSpec),
  /steps\[2\]\.configuration has unsupported key options/,
  'Expected options key to fail closed'
);
console.log('Test 5 (options property fails closed / planner unreachable): PASS');

// 6. Test outputFieldName collision with existing field fails closed
const collisionSpec = JSON.parse(JSON.stringify(baseSpec));
collisionSpec.steps[2].configuration.outputFieldName = 'title'; // 'title' already exists
assert.throws(
  () => compileNodewiseSpecification(collisionSpec),
  /collides with an existing input field/,
  'Expected field collision to fail closed'
);
console.log('Test 6 (outputFieldName collision fails closed): PASS');

// 7. Test wrong input type (non-string field) fails closed
const wrongTypeSpec = JSON.parse(JSON.stringify(baseSpec));
wrongTypeSpec.steps[2].configuration.field = 'completed'; // boolean, not string
assert.throws(
  () => compileNodewiseSpecification(wrongTypeSpec),
  /需要 string/,
  'Expected non-string field to fail closed'
);
console.log('Test 7 (Non-string field fails closed): PASS');

// 8. Test input cardinality not items fails closed
// Reference public_literal jsonplaceholder.user which has cardinality one_object
const nonItemsSpec = JSON.parse(JSON.stringify(baseSpec));
nonItemsSpec.steps.splice(1, 0, {
  id: 'fetch-user',
  capability: 'http_request',
  requiredUserSetup: [],
  configuration: {
    method: 'GET',
    url: { kind: 'public_literal', reference: 'https://jsonplaceholder.typicode.com/users/1', cardinality: 'one_object' },
  },
});
nonItemsSpec.steps[3].configuration.input = { kind: 'prior_step', reference: 'fetch-user.response', cardinality: 'one_object' };
assert.throws(
  () => compileNodewiseSpecification(nonItemsSpec),
  /xml_convert requires items input/,
  'Expected non-items input cardinality to fail closed'
);
console.log('Test 8 (Non-items cardinality fails closed): PASS');

// 9. Test explicit typeVersion === 1 assertion
assert.strictEqual(xmlNode.typeVersion, 1);
assert.strictEqual(wfJsonToXml.nodes[2].typeVersion, 1);
console.log('Test 9 (Emitted typeVersion is exactly 1): PASS');

// 10. Test deterministic compilation (byte-identical JSON)
const run1 = JSON.stringify(compileNodewiseSpecification(baseSpec));
const run2 = JSON.stringify(compileNodewiseSpecification(baseSpec));
assert.strictEqual(run1, run2);
console.log('Test 10 (Deterministic compilation output): PASS');

// 11. Test registry and approval wiring
const skill = getSkill('transform.xml_convert');
assert.strictEqual(skill.id, 'transform.xml_convert');
assert.strictEqual(skill.compiler, 'nodewise');
assert.strictEqual(skill.requiresUserSetup, false);
assert.strictEqual(skill.risk, 'read_only');

const action = defaultRegistry.getAction('xml_convert');
assert.strictEqual(action.cardId, 'xml_convert');
assert.strictEqual(action.nodeType, 'n8n-nodes-base.xml');
assert.strictEqual(action.version, 1);

const skillIds = skillIdsForSpecification(baseSpec);
assert.ok(skillIds.includes('transform.xml_convert'));
console.log('Test 11 (Registry, catalog, and approval wiring verified): PASS');

// 12. Test falsy outputFieldName fails closed
const falsyCases = ['', null, false, 0];
for (const falsyVal of falsyCases) {
  const badSpec = JSON.parse(JSON.stringify(baseSpec));
  badSpec.steps[2].configuration.outputFieldName = falsyVal;
  assert.throws(
    () => compileNodewiseSpecification(badSpec),
    /steps\[2\]\.configuration\.outputFieldName must be a simple field identifier/,
    `Expected falsy outputFieldName ${JSON.stringify(falsyVal)} to fail closed`
  );
}
console.log('Test 12 (Falsy outputFieldName fails closed): PASS');

console.log('ALL transform.xml_convert REPOSITORY REGRESSION TESTS PASS (100% verified)');
