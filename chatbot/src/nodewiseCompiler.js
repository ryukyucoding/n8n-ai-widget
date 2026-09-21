'use strict';

const crypto = require('node:crypto');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');
const { validatePublicHttpsUrl, VERIFIED_PATTERN_HOSTS } = require('./publicUrlPolicy');
const {
  assertSourceRegistered,
  assertField,
  assertCardinality,
} = require('./sourceSchemaRegistry');

const CAPABILITIES = new Set(['manual_trigger', 'http_request', 'data_transform', 'set_output', 'data_branch', 'data_merge', 'data_loop']);
const TRANSFORMS = new Set(['select_fields', 'count_false_boolean', 'join_object_and_count_false_boolean', 'sort_items', 'remove_duplicates', 'limit_items', 'rename_keys', 'format_date', 'hash_data', 'render_markdown', 'xml_convert']);
const MARKDOWN_MODES = new Set(['markdownToHtml', 'htmlToMarkdown']);
const XML_MODES = new Set(['jsonToxml', 'xmlToJson']);
const SORT_ORDERS = new Set(['ascending', 'descending']);
const LIMIT_KEEP = new Set(['firstItems', 'lastItems']);
const CARDINALITIES = new Set(['one_object', 'items']);
const VALUE_TYPES = new Set(['string', 'number', 'boolean']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function latestCard(type) {
  const versions = Object.keys(runtimeSchemas.nodeTypes?.[type]?.versions || {})
    .filter((value) => Number.isFinite(Number(value)))
    .sort((left, right) => Number(right) - Number(left));
  assert(versions.length, `runtime does not expose ${type}`);
  return { type, typeVersion: Number(versions[0]) };
}

function safeIdentifier(value, field) {
  assert(typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value), `${field} must be a simple field identifier`);
  return value;
}

function source(value, field, previousSteps, outputs) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${field} must be an object`);
  assert(['public_literal', 'prior_step'].includes(value.kind), `${field}.kind is unsupported`);
  assert(CARDINALITIES.has(value.cardinality), `${field}.cardinality is unsupported`);
  assert(typeof value.reference === 'string' && value.reference.trim(), `${field}.reference is required`);
  if (value.kind === 'public_literal') {
    // beta 只跑受驗證 pattern，因此顯式帶入該邊界；denylist 同時作為第二道防線。
    validatePublicHttpsUrl(value.reference, `${field}.reference`,
      { allowedHosts: VERIFIED_PATTERN_HOSTS });
    const registered = assertSourceRegistered(value.reference, `${field}.reference`);
    assertCardinality(registered, value.cardinality, `${field}.cardinality`);
    return {
      value: { kind: value.kind, reference: value.reference, cardinality: value.cardinality },
      output: { cardinality: registered.cardinality, fields: registered.fields, source: registered },
    };
  } else {
    const stepId = value.reference.split('.', 1)[0];
    assert(previousSteps.has(stepId), `${field}.reference must reference an earlier step`);
    const output = outputs.get(stepId);
    assert(output, `${field}.reference must reference a step with a declared output`);
    assert(output.cardinality === value.cardinality,
      `${field}.cardinality must match ${stepId} output cardinality ${output.cardinality}`);
    return {
      value: { kind: value.kind, reference: value.reference, cardinality: value.cardinality },
      output,
    };
  }
}

function mappings(value, field) {
  assert(Array.isArray(value) && value.length && value.length <= 20, `${field} must contain 1 to 20 mappings`);
  return value.map((mapping, index) => {
    assert(mapping && typeof mapping === 'object' && !Array.isArray(mapping), `${field}[${index}] must be an object`);
    const from = safeIdentifier(mapping.from, `${field}[${index}].from`);
    const to = safeIdentifier(mapping.to, `${field}[${index}].to`);
    assert(VALUE_TYPES.has(mapping.valueType), `${field}[${index}].valueType is unsupported`);
    return { from, to, valueType: mapping.valueType };
  });
}

function assertInputField(input, fieldName, { expectedType = null, usedBy = '' } = {}) {
  if (input.source) return assertField(input.source, fieldName, { expectedType, usedBy });
  const actual = input.fields[fieldName];
  assert(actual, `${usedBy || 'input'} 沒有宣告欄位 ${fieldName}。`
    + `已宣告的欄位：${Object.keys(input.fields).join(', ')}`);
  if (expectedType) {
    assert(actual === expectedType,
      `${usedBy || 'input'}.${fieldName} 的型別是 ${actual}，但需要 ${expectedType}`);
  }
  return actual;
}

function validateMappings(input, value, field) {
  const result = mappings(value, field);
  for (const mapping of result) {
    const actual = assertInputField(input, mapping.from, {
      expectedType: mapping.valueType,
      usedBy: field,
    });
    assert(actual === mapping.valueType,
      `${field} 宣告 ${mapping.from} 為 ${mapping.valueType}，但輸入是 ${actual}`);
  }
  return result;
}

function mappedOutput(input, value, field) {
  const result = validateMappings(input, value, field);
  return { mappings: result, output: { cardinality: 'one_object', fields: Object.fromEntries(result.map((item) => [item.to, item.valueType])) } };
}

function validateSpecification(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'specification must be an object');
  assert(value.schemaVersion === '1.0', 'schemaVersion must be 1.0');
  assert(value.kind === 'nodewise_step_specification', 'kind must be nodewise_step_specification');
  assert(typeof value.goal === 'string' && value.goal.trim(), 'goal is required');
  assert(Array.isArray(value.requiredUserSetup) && value.requiredUserSetup.length === 0, 'user setup must be resolved before compilation');
  assert(value.expectedOutput?.deliveryShape === 'one_object', 'only one_object output is supported');
  assert(Array.isArray(value.expectedOutput.fields) && value.expectedOutput.fields.length > 0, 'expectedOutput.fields is required');
  const expectedOutputFields = value.expectedOutput.fields.map((field, index) => safeIdentifier(field, `expectedOutput.fields[${index}]`));
  assert(new Set(expectedOutputFields).size === expectedOutputFields.length, 'expectedOutput.fields must be unique');
  assert(Array.isArray(value.steps) && value.steps.length >= 2 && value.steps.length <= 10, 'steps must contain 2 to 10 entries');

  const seen = new Set();
  const outputs = new Map();
  const steps = value.steps.map((step, index) => {
    assert(step && typeof step === 'object' && !Array.isArray(step), `steps[${index}] must be an object`);
    assert(typeof step.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(step.id), `steps[${index}].id is invalid`);
    assert(!seen.has(step.id), `steps[${index}].id must be unique`);
    assert(CAPABILITIES.has(step.capability), `steps[${index}].capability is unsupported`);
    assert(Array.isArray(step.requiredUserSetup) && step.requiredUserSetup.length === 0, `steps[${index}] requires user setup`);
    const config = step.configuration || {};
    let configuration;
    let output = null;
    if (step.capability === 'manual_trigger') {
      assert(index === 0 && Object.keys(config).length === 0, 'manual_trigger must be the first empty step');
      configuration = {};
    } else if (step.capability === 'http_request') {
      assert(config.method === 'GET', 'only public GET requests are supported');
      const input = source(config.url, `steps[${index}].configuration.url`, seen, outputs);
      configuration = { method: 'GET', url: input.value };
      assert(configuration.url.kind === 'public_literal', 'HTTP URL must be public_literal');
      output = input.output;
    } else if (step.capability === 'data_transform') {
      assert(TRANSFORMS.has(config.operation), `steps[${index}].configuration.operation is unsupported`);
      if (config.operation === 'select_fields') {
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        const mapped = mappedOutput(input.output, config.mappings, `steps[${index}].configuration.mappings`);
        configuration = { operation: config.operation, input: input.value, mappings: mapped.mappings };
        assert(configuration.input.cardinality === 'one_object', 'select_fields requires one_object input');
        output = mapped.output;
      } else if (config.operation === 'count_false_boolean') {
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        configuration = { operation: config.operation, input: input.value, field: safeIdentifier(config.field, 'field'), totalField: safeIdentifier(config.totalField, 'totalField'), falseCountField: safeIdentifier(config.falseCountField, 'falseCountField') };
        assert(configuration.input.cardinality === 'items', 'count_false_boolean requires items input');
        assertInputField(input.output, configuration.field, { expectedType: 'boolean', usedBy: `steps[${index}].configuration.field` });
        output = { cardinality: 'one_object', fields: { [configuration.totalField]: 'number', [configuration.falseCountField]: 'number' } };
      } else if (config.operation === 'limit_items') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'limit', 'keep'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'limit_items requires items input');
        assert(Number.isInteger(config.limit) && config.limit >= 1 && config.limit <= 1000,
          'limit_items limit must be an integer between 1 and 1000');
        // keep is optional; default preserves the original first-items behaviour.
        const keep = config.keep === undefined ? 'firstItems' : config.keep;
        assert(LIMIT_KEEP.has(keep), 'limit_items keep must be firstItems or lastItems');
        // Preserve the input item schema exactly — limit removes items, never invents or drops fields.
        configuration = { operation: config.operation, input: input.value, limit: config.limit, keep };
        output = { cardinality: 'items', fields: input.output.fields };
      } else if (config.operation === 'sort_items') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'field', 'order'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'sort_items requires items input');
        const field = safeIdentifier(config.field, `steps[${index}].configuration.field`);
        assertInputField(input.output, field, { usedBy: `steps[${index}].configuration.field` });
        assert(SORT_ORDERS.has(config.order), 'sort_items order must be ascending or descending');
        // Sorting reorders items only; the item schema is preserved exactly.
        configuration = { operation: config.operation, input: input.value, field, order: config.order };
        output = { cardinality: 'items', fields: input.output.fields };
      } else if (config.operation === 'remove_duplicates') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'field'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'remove_duplicates requires items input');
        const field = safeIdentifier(config.field, `steps[${index}].configuration.field`);
        assertInputField(input.output, field, { usedBy: `steps[${index}].configuration.field` });
        // Dropping duplicate items removes rows only; the item schema is preserved exactly.
        configuration = { operation: config.operation, input: input.value, field };
        output = { cardinality: 'items', fields: input.output.fields };
      } else if (config.operation === 'rename_keys') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'renames'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'rename_keys requires items input');
        assert(Array.isArray(config.renames) && config.renames.length >= 1 && config.renames.length <= 20,
          'rename_keys renames must contain 1 to 20 mappings');

        const seenFrom = new Set();
        const seenTo = new Set();
        const renames = config.renames.map((mapping, rIndex) => {
          assert(mapping && typeof mapping === 'object' && !Array.isArray(mapping),
            `steps[${index}].configuration.renames[${rIndex}] must be an object`);
          for (const k of Object.keys(mapping)) {
            assert(['from', 'to'].includes(k),
              `steps[${index}].configuration.renames[${rIndex}] has unsupported key ${k}`);
          }
          const from = safeIdentifier(mapping.from, `steps[${index}].configuration.renames[${rIndex}].from`);
          const to = safeIdentifier(mapping.to, `steps[${index}].configuration.renames[${rIndex}].to`);
          assert(from !== to, `rename_keys from and to must be distinct: ${from} cannot be renamed to itself`);
          assert(!seenFrom.has(from), `rename_keys renames contains duplicate source field ${from}`);
          assert(!seenTo.has(to), `rename_keys renames contains duplicate target field ${to}`);
          seenFrom.add(from);
          seenTo.add(to);
          return { from, to };
        });

        for (const mapping of renames) {
          assertInputField(input.output, mapping.from, { usedBy: `steps[${index}].configuration.renames` });
        }

        const inputFieldNames = new Set(Object.keys(input.output.fields));
        for (const mapping of renames) {
          assert(!inputFieldNames.has(mapping.to),
            `rename_keys target field ${mapping.to} collides with an existing input field`);
        }

        const renameMap = new Map(renames.map((m) => [m.from, m.to]));
        const outputFields = {};
        for (const [fieldName, fieldType] of Object.entries(input.output.fields)) {
          const finalName = renameMap.has(fieldName) ? renameMap.get(fieldName) : fieldName;
          outputFields[finalName] = fieldType;
        }

        configuration = { operation: config.operation, input: input.value, renames };
        output = { cardinality: 'items', fields: outputFields };
      } else if (config.operation === 'format_date') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'field', 'outputFieldName', 'format'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'format_date requires items input');
        const field = safeIdentifier(config.field, `steps[${index}].configuration.field`);
        assertInputField(input.output, field, { usedBy: `steps[${index}].configuration.field` });
        const outputFieldName = safeIdentifier(config.outputFieldName, `steps[${index}].configuration.outputFieldName`);
        assert(typeof config.format === 'string' && config.format.trim(), 'format_date requires a non-empty format string');
        configuration = {
          operation: config.operation,
          input: input.value,
          field,
          outputFieldName,
          format: config.format.trim(),
        };
        output = {
          cardinality: 'items',
          fields: { ...input.output.fields, [outputFieldName]: 'string' },
        };
      } else if (config.operation === 'hash_data') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'field', 'algorithm', 'outputFieldName', 'encoding'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'hash_data requires items input');
        const field = safeIdentifier(config.field, `steps[${index}].configuration.field`);
        assertInputField(input.output, field, { usedBy: `steps[${index}].configuration.field` });
        const outputFieldName = safeIdentifier(config.outputFieldName || 'hashValue', `steps[${index}].configuration.outputFieldName`);
        const algorithm = config.algorithm || 'SHA256';
        assert(['SHA256', 'MD5', 'SHA512', 'SHA384'].includes(algorithm), 'hash_data algorithm is unsupported');
        const encoding = config.encoding || 'hex';
        assert(['hex', 'base64'].includes(encoding), 'hash_data encoding must be hex or base64');
        configuration = {
          operation: config.operation,
          input: input.value,
          field,
          algorithm,
          outputFieldName,
          encoding,
        };
        output = {
          cardinality: 'items',
          fields: { ...input.output.fields, [outputFieldName]: 'string' },
        };
      } else if (config.operation === 'render_markdown') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'mode', 'field', 'outputFieldName'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'render_markdown requires items input');
        const mode = config.mode;
        assert(MARKDOWN_MODES.has(mode), 'render_markdown mode must be markdownToHtml or htmlToMarkdown');
        const field = safeIdentifier(config.field, `steps[${index}].configuration.field`);
        assertInputField(input.output, field, { expectedType: 'string', usedBy: `steps[${index}].configuration.field` });
        const defaultOutputField = mode === 'markdownToHtml' ? 'renderedHtml' : 'renderedMarkdown';
        const rawOutputField = config.outputFieldName !== undefined ? config.outputFieldName : defaultOutputField;
        const outputFieldName = safeIdentifier(rawOutputField, `steps[${index}].configuration.outputFieldName`);
        assert(!input.output.fields[outputFieldName], `render_markdown outputFieldName "${outputFieldName}" collides with an existing input field`);
        configuration = {
          operation: config.operation,
          input: input.value,
          mode,
          field,
          outputFieldName,
        };
        output = {
          cardinality: 'items',
          fields: { ...input.output.fields, [outputFieldName]: 'string' },
        };
      } else if (config.operation === 'xml_convert') {
        for (const key of Object.keys(config)) {
          assert(['operation', 'input', 'mode', 'field', 'outputFieldName'].includes(key), `steps[${index}].configuration has unsupported key ${key}`);
        }
        const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
        assert(input.value.cardinality === 'items', 'xml_convert requires items input');
        const mode = config.mode;
        assert(XML_MODES.has(mode), 'xml_convert mode must be jsonToxml or xmlToJson');
        const field = safeIdentifier(config.field, `steps[${index}].configuration.field`);
        assertInputField(input.output, field, { expectedType: 'string', usedBy: `steps[${index}].configuration.field` });
        const defaultOutputField = mode === 'jsonToxml' ? 'xmlOutput' : 'jsonOutput';
        const rawOutputField = config.outputFieldName !== undefined ? config.outputFieldName : defaultOutputField;
        const outputFieldName = safeIdentifier(rawOutputField, `steps[${index}].configuration.outputFieldName`);
        assert(!input.output.fields[outputFieldName], `xml_convert outputFieldName "${outputFieldName}" collides with an existing input field`);
        configuration = {
          operation: config.operation,
          input: input.value,
          mode,
          field,
          outputFieldName,
        };
        output = {
          cardinality: 'items',
          fields: { ...input.output.fields, [outputFieldName]: 'string' },
        };
      } else {
        const objectInput = source(config.objectInput, `steps[${index}].configuration.objectInput`, seen, outputs);
        const itemsInput = source(config.itemsInput, `steps[${index}].configuration.itemsInput`, seen, outputs);
        const mapped = validateMappings(objectInput.output, config.objectMappings, `steps[${index}].configuration.objectMappings`);
        configuration = {
          operation: config.operation, objectInput: objectInput.value, itemsInput: itemsInput.value,
          objectMappings: mapped,
          field: safeIdentifier(config.field, 'field'), totalField: safeIdentifier(config.totalField, 'totalField'), falseCountField: safeIdentifier(config.falseCountField, 'falseCountField'),
        };
        assert(configuration.objectInput.cardinality === 'one_object', 'join object input must be one_object');
        assert(configuration.itemsInput.cardinality === 'items', 'join items input must be items');
        assertInputField(itemsInput.output, configuration.field, { expectedType: 'boolean', usedBy: `steps[${index}].configuration.field` });
        output = { cardinality: 'one_object', fields: {
          ...Object.fromEntries(mapped.map((item) => [item.to, item.valueType])),
          [configuration.totalField]: 'number', [configuration.falseCountField]: 'number',
        } };
      }
    } else if (step.capability === 'data_branch') {
      assert(config.operation === 'branch_if', `steps[${index}].configuration.operation must be branch_if`);
      const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
      assert(input.value.cardinality === 'items', 'branch_if requires items input');
      assert(config.condition && typeof config.condition === 'object', 'branch_if requires condition object');
      const field = safeIdentifier(config.condition.field, `steps[${index}].configuration.condition.field`);
      assertInputField(input.output, field, { usedBy: `steps[${index}].configuration.condition.field` });
      assert(['equals', 'not_equals'].includes(config.condition.operator), 'branch_if operator must be equals or not_equals');
      assert(Array.isArray(config.branches) && config.branches.length === 2, 'branch_if requires exactly two branch step IDs [trueStep, falseStep]');
      configuration = {
        operation: config.operation,
        input: input.value,
        condition: { field, operator: config.condition.operator, value: config.condition.value },
        branches: config.branches.map((b) => {
          assert(typeof b === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(b), 'branch step ID is invalid');
          return b;
        }),
      };
      output = { cardinality: 'items', fields: input.output.fields };
    } else if (step.capability === 'data_merge') {
      assert(config.operation === 'merge_append', `steps[${index}].configuration.operation must be merge_append`);
      assert(Array.isArray(config.inputs) && config.inputs.length === 2, 'merge_append requires exactly two input references');
      const in1 = source(config.inputs[0], `steps[${index}].configuration.inputs[0]`, seen, outputs);
      const in2 = source(config.inputs[1], `steps[${index}].configuration.inputs[1]`, seen, outputs);
      assert(in1.value.cardinality === 'items' && in2.value.cardinality === 'items', 'merge_append inputs must both be items');
      configuration = { operation: config.operation, inputs: [in1.value, in2.value] };
      output = { cardinality: 'items', fields: in1.output.fields };
    } else if (step.capability === 'data_loop') {
      assert(config.operation === 'loop_items', `steps[${index}].configuration.operation must be loop_items`);
      const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
      assert(input.value.cardinality === 'items', 'loop_items requires items input');
      const batchSize = config.batchSize !== undefined ? config.batchSize : 1;
      assert(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 100, 'loop_items batchSize must be an integer between 1 and 100');
      assert(Array.isArray(config.loopBodySteps) && config.loopBodySteps.length >= 1, 'loop_items requires at least one loopBodyStep');
      const validatedBody = config.loopBodySteps.map((b) => {
        assert(typeof b === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(b), 'loopBodyStep ID is invalid');
        return b;
      });
      configuration = {
        operation: config.operation,
        input: input.value,
        batchSize,
        loopBodySteps: validatedBody,
      };
      output = { cardinality: 'items', fields: input.output.fields };
    } else {
      const input = source(config.input, `steps[${index}].configuration.input`, seen, outputs);
      const mapped = mappedOutput(input.output, config.mappings, `steps[${index}].configuration.mappings`);
      configuration = { input: input.value, mappings: mapped.mappings };
      assert(configuration.input.cardinality === 'one_object', 'set_output requires one_object input');
      output = mapped.output;
    }
    seen.add(step.id);
    if (output) outputs.set(step.id, output);
    return {
      id: step.id,
      capability: step.capability,
      requiredUserSetup: [],
      configuration,
    };
  });
  const finalStep = steps.at(-1);
  const finalFields = finalStep.capability === 'data_transform' && finalStep.configuration.operation === 'join_object_and_count_false_boolean'
    ? [...finalStep.configuration.objectMappings.map((mapping) => mapping.to), finalStep.configuration.totalField, finalStep.configuration.falseCountField]
    : finalStep.capability === 'set_output' || (finalStep.capability === 'data_transform' && finalStep.configuration.operation === 'select_fields')
      ? finalStep.configuration.mappings.map((mapping) => mapping.to)
      : [];
  assert(finalFields.length > 0, 'final step must produce declared output fields');
  assert(finalFields.length === expectedOutputFields.length && finalFields.every((field, index) => field === expectedOutputFields[index]), 'final step fields must match expectedOutput.fields');

  // Return the complete canonical IR. Callers use this value for review,
  // approval binding, and compilation, so dropping envelope fields here would
  // make a validated planner result impossible to validate a second time.
  return {
    schemaVersion: '1.0',
    kind: 'nodewise_step_specification',
    goal: value.goal.trim(),
    requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: expectedOutputFields },
    steps,
  };
}

function nodeId(stepId) {
  const hex = crypto.createHash('sha256').update(`nodewise-compiler:${stepId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function assignments(items) {
  return { assignments: { assignments: items.map((item) => ({ name: item.to, value: `={{ $json.${item.from} }}`, type: item.valueType })) }, includeOtherFields: false, options: {} };
}

function compileNodewiseSpecification(specification) {
  const spec = validateSpecification(specification);
  const names = Object.fromEntries(spec.steps.map((step, index) => [step.id, `Step ${index + 1}: ${step.id}`]));
  const nodes = spec.steps.map((step, index) => {
    const config = step.configuration;
    let type;
    let parameters = {};
    if (step.capability === 'manual_trigger') type = 'n8n-nodes-base.manualTrigger';
    if (step.capability === 'http_request') {
      type = 'n8n-nodes-base.httpRequest';
      parameters = { method: 'GET', url: config.url.reference, options: {} };
    }
    if (step.capability === 'set_output' || (step.capability === 'data_transform' && config.operation === 'select_fields')) {
      type = 'n8n-nodes-base.set';
      parameters = assignments(config.mappings);
    }
    if (step.capability === 'data_transform' && config.operation === 'count_false_boolean') {
      type = 'n8n-nodes-base.code';
      parameters = { jsCode: ['const records = $input.all().map((item) => item.json);', `const falseCount = records.filter((record) => record.${config.field} === false).length;`, `return [{ json: { ${config.totalField}: records.length, ${config.falseCountField}: falseCount } }];`].join('\n') };
    }
    if (step.capability === 'data_transform' && config.operation === 'limit_items') {
      type = 'n8n-nodes-base.limit';
      parameters = { maxItems: config.limit, keep: config.keep === undefined ? 'firstItems' : config.keep };
    }
    if (step.capability === 'data_transform' && config.operation === 'sort_items') {
      type = 'n8n-nodes-base.sort';
      parameters = { type: 'simple', sortFieldsUi: { sortField: [{ fieldName: config.field, order: config.order }] } };
    }
    if (step.capability === 'data_transform' && config.operation === 'remove_duplicates') {
      type = 'n8n-nodes-base.removeDuplicates';
      parameters = { operation: 'removeDuplicateInputItems', compare: 'selectedFields', fieldsToCompare: config.field };
    }
    if (step.capability === 'data_transform' && config.operation === 'rename_keys') {
      type = 'n8n-nodes-base.renameKeys';
      parameters = {
        keys: {
          key: config.renames.map((mapping) => ({
            currentKey: mapping.from,
            newKey: mapping.to,
          })),
        },
        additionalOptions: {},
      };
    }
    if (step.capability === 'data_transform' && config.operation === 'join_object_and_count_false_boolean') {
      type = 'n8n-nodes-base.code';
      const sourceStep = config.objectInput.reference.split('.', 1)[0];
      const fields = config.objectMappings.map((item) => `${item.to}: source.${item.from}`).join(', ');
      parameters = { jsCode: [`const source = $('${names[sourceStep]}').first().json;`, 'const records = $input.all().map((item) => item.json);', `const falseCount = records.filter((record) => record.${config.field} === false).length;`, `return [{ json: { ${fields}, ${config.totalField}: records.length, ${config.falseCountField}: falseCount } }];`].join('\n') };
    }
    if (step.capability === 'data_transform' && config.operation === 'format_date') {
      type = 'n8n-nodes-base.dateTime';
      parameters = {
        operation: 'formatDate',
        date: `={{ $json.${config.field} }}`,
        format: config.format,
        outputFieldName: config.outputFieldName,
        options: { includeInputFields: true },
      };
    }
    if (step.capability === 'data_transform' && config.operation === 'hash_data') {
      // Pinned strictly to Crypto typeVersion 1 per Q10 contract (do not use latestCard)
      const nodeObj = {
        id: nodeId(step.id),
        name: names[step.id],
        type: 'n8n-nodes-base.crypto',
        typeVersion: 1,
        parameters: {
          action: 'hash',
          type: config.algorithm || 'SHA256',
          value: `={{ $json.${config.field} }}`,
          dataPropertyName: config.outputFieldName || 'hashValue',
          encoding: config.encoding || 'hex',
        },
        position: [240 + index * 260, 300],
      };
      return nodeObj;
    }
    if (step.capability === 'data_transform' && config.operation === 'render_markdown') {
      // Pinned to version 1 strictly per OVR-3 proposal (do not use latestCard)
      const fieldProp = config.mode === 'markdownToHtml' ? 'markdown' : 'html';
      const nodeObj = {
        id: nodeId(step.id),
        name: names[step.id],
        type: 'n8n-nodes-base.markdown',
        typeVersion: 1,
        parameters: {
          mode: config.mode,
          [fieldProp]: `={{ $json.${config.field} }}`,
          destinationKey: config.outputFieldName,
          options: {},
        },
        position: [240 + index * 260, 300],
      };
      return nodeObj;
    }
    if (step.capability === 'data_transform' && config.operation === 'xml_convert') {
      // Pinned strictly to XML typeVersion 1 per contract (do not use latestCard)
      // dataPropertyName carries config.field for xmlToJson (read property) and
      // config.outputFieldName for jsonToxml (target XML output property).
      // All options.* left absent/closed.
      const propName = config.mode === 'xmlToJson' ? config.field : config.outputFieldName;
      const nodeObj = {
        id: nodeId(step.id),
        name: names[step.id],
        type: 'n8n-nodes-base.xml',
        typeVersion: 1,
        parameters: {
          mode: config.mode,
          dataPropertyName: propName,
          options: {},
        },
        position: [240 + index * 260, 300],
      };
      return nodeObj;
    }
    if (step.capability === 'data_branch' && config.operation === 'branch_if') {
      type = 'n8n-nodes-base.if';
      parameters = {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'cond-1',
              leftValue: `={{ $json.${config.condition.field} }}`,
              rightValue: config.condition.value,
              operator: { type: typeof config.condition.value === 'boolean' ? 'boolean' : 'string', operation: config.condition.operator },
            },
          ],
          combinator: 'and',
        },
        options: {},
      };
    }
    if (step.capability === 'data_merge' && config.operation === 'merge_append') {
      type = 'n8n-nodes-base.merge';
      parameters = { mode: 'append' };
    }
    if (step.capability === 'data_loop' && config.operation === 'loop_items') {
      type = 'n8n-nodes-base.splitInBatches';
      parameters = {
        batchSize: config.batchSize !== undefined ? config.batchSize : 1,
        options: {},
      };
    }
    const card = (type === 'n8n-nodes-base.crypto' || type === 'n8n-nodes-base.xml')
      ? { type, typeVersion: 1 }
      : latestCard(type);
    return { id: nodeId(step.id), name: names[step.id], ...card, parameters, position: [240 + index * 260, 300] };
  });

  const connections = {};
  const hasBranch = spec.steps.some((s) => s.capability === 'data_branch');
  const hasLoop = spec.steps.some((s) => s.capability === 'data_loop');

  if (!hasBranch && !hasLoop) {
    for (let index = 0; index < nodes.length - 1; index += 1) {
      connections[nodes[index].name] = { main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]] };
    }
  } else {
    // Non-linear DAG and cyclic loop connection serialization
    const stepById = new Map(spec.steps.map((s, i) => [s.id, { step: s, index: i, name: names[s.id] }]));
    const mergeStep = spec.steps.find((s) => s.capability === 'data_merge');
    const mergeName = mergeStep ? names[mergeStep.id] : null;
    const mergeInputs = mergeStep?.configuration?.inputs || [];

    const loopStep = spec.steps.find((s) => s.capability === 'data_loop');
    const loopName = loopStep ? names[loopStep.id] : null;
    const loopBodySteps = loopStep?.configuration?.loopBodySteps || [];
    const loopBodySet = new Set(loopBodySteps);
    const loopTailId = loopBodySteps.at(-1);

    for (let i = 0; i < spec.steps.length; i += 1) {
      const s = spec.steps[i];
      const sourceName = names[s.id];

      if (s.capability === 'data_branch') {
        const trueTargetId = s.configuration.branches[0];
        const falseTargetId = s.configuration.branches[1];
        const trueTargetName = stepById.get(trueTargetId)?.name;
        const falseTargetName = stepById.get(falseTargetId)?.name;
        connections[sourceName] = {
          main: [
            trueTargetName ? [{ node: trueTargetName, type: 'main', index: 0 }] : [],
            falseTargetName ? [{ node: falseTargetName, type: 'main', index: 0 }] : [],
          ],
        };
      } else if (s.capability === 'data_loop') {
        // Output 0 = loop iteration body head, Output 1 = done output (next step after loop)
        const loopHeadId = loopBodySteps[0];
        const loopHeadName = stepById.get(loopHeadId)?.name;
        // The done step is the step immediately following the loop body steps in the spec
        const doneStepIndex = spec.steps.findIndex((st, idx) => idx > i && !loopBodySet.has(st.id));
        const doneName = doneStepIndex >= 0 ? names[spec.steps[doneStepIndex].id] : null;

        connections[sourceName] = {
          main: [
            loopHeadName ? [{ node: loopHeadName, type: 'main', index: 0 }] : [],
            doneName ? [{ node: doneName, type: 'main', index: 0 }] : [],
          ],
        };
      } else if (s.capability === 'data_merge') {
        if (i < spec.steps.length - 1) {
          connections[sourceName] = { main: [[{ node: names[spec.steps[i + 1].id], type: 'main', index: 0 }]] };
        }
      } else if (hasLoop && s.id === loopTailId && loopName) {
        // Loop body tail node connects back to splitInBatches Input 0 (cyclic back-edge)
        connections[sourceName] = { main: [[{ node: loopName, type: 'main', index: 0 }]] };
      } else {
        // Check if this step is an input to the Merge node
        const mergeInputIndex = mergeInputs.findIndex((ref) => ref.reference.startsWith(s.id));
        if (mergeInputIndex >= 0 && mergeName) {
          connections[sourceName] = { main: [[{ node: mergeName, type: 'main', index: mergeInputIndex }]] };
        } else if (i < spec.steps.length - 1) {
          connections[sourceName] = { main: [[{ node: names[spec.steps[i + 1].id], type: 'main', index: 0 }]] };
        }
      }
    }
  }
  const goalStr = typeof spec.goal === 'string' ? spec.goal.trim() : '';
  const goalHash = crypto.createHash('sha256').update(goalStr).digest('hex').slice(0, 8);
  const rawPrefix = `Nodewise compiler - ${goalStr}`;
  // Enforce name <= 128 chars while preserving readable prefix and deterministic short hash suffix
  const workflowName = rawPrefix.length <= 128
    ? rawPrefix
    : `${rawPrefix.slice(0, 116)}...-${goalHash}`;

  return { name: workflowName, active: false, settings: { executionOrder: 'v1' }, nodes, connections };
}

module.exports = { compileNodewiseSpecification, validateSpecification };
