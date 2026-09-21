'use strict';

const crypto = require('node:crypto');
const { validateSpecification, compileNodewiseSpecification } = require('./nodewiseCompiler');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeIdentifier(value, field) {
  assert(typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value), `${field} must be a simple field identifier`);
  return value;
}

function validateContract(contract, field) {
  assert(contract && typeof contract === 'object' && !Array.isArray(contract), `${field} must be an object`);
  assert(['one_object', 'items'].includes(contract.cardinality), `${field}.cardinality must be one_object or items`);
  assert(contract.fields && typeof contract.fields === 'object' && !Array.isArray(contract.fields), `${field}.fields must be an object`);
  for (const [k, v] of Object.entries(contract.fields)) {
    safeIdentifier(k, `${field}.fields key`);
    assert(['string', 'number', 'boolean'].includes(v), `${field}.fields[${k}] type ${v} is unsupported`);
  }
}

/**
 * Validates a nodewise_subplan_specification according to Phase 1:
 * - schemaVersion: '1.0'
 * - kind: 'nodewise_subplan_specification'
 * - blocks: exactly 1 Block (Phase 1)
 * - composition: empty array (Phase 1)
 * - checkpoint: optional boolean (inert in Phase 1)
 * - expectedOutput matches the single block output
 */
function validateSubplanSpecification(specification) {
  assert(specification && typeof specification === 'object' && !Array.isArray(specification), 'subplan specification must be an object');
  assert(specification.schemaVersion === '1.0', 'schemaVersion must be 1.0');
  assert(specification.kind === 'nodewise_subplan_specification', 'kind must be nodewise_subplan_specification');
  assert(typeof specification.goal === 'string' && specification.goal.trim(), 'goal is required');
  assert(Array.isArray(specification.blocks), 'blocks must be an array');
  assert(specification.blocks.length === 1, 'Phase 1 subplan specification must contain exactly one block');
  assert(Array.isArray(specification.composition) && specification.composition.length === 0, 'Phase 1 composition must be empty');

  const block = specification.blocks[0];
  assert(block && typeof block === 'object' && !Array.isArray(block), 'block must be an object');
  assert(typeof block.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(block.id), 'block.id is invalid');
  assert(typeof block.goal === 'string' && block.goal.trim(), 'block.goal is required');

  validateContract(block.input, 'block.input');
  validateContract(block.output, 'block.output');

  if (block.checkpoint !== undefined) {
    assert(typeof block.checkpoint === 'boolean', 'block.checkpoint must be a boolean');
  }

  // Construct equivalent flat spec for validation
  const flatSpec = {
    schemaVersion: '1.0',
    kind: 'nodewise_step_specification',
    goal: specification.goal,
    requiredUserSetup: [],
    expectedOutput: specification.expectedOutput,
    steps: block.steps,
  };

  const validatedFlat = validateSpecification(flatSpec);

  // In Phase 1, block.output must match expectedOutput fields
  assert(specification.expectedOutput?.deliveryShape === block.output.cardinality, 'expectedOutput deliveryShape must match block.output cardinality');
  assert(Array.isArray(specification.expectedOutput.fields), 'expectedOutput.fields must be an array');
  for (const field of specification.expectedOutput.fields) {
    assert(block.output.fields[field], `block.output missing declared expectedOutput field ${field}`);
  }

  return {
    schemaVersion: '1.0',
    kind: 'nodewise_subplan_specification',
    goal: specification.goal.trim(),
    blocks: [
      {
        id: block.id,
        goal: block.goal.trim(),
        input: block.input,
        output: block.output,
        checkpoint: block.checkpoint === true,
        steps: validatedFlat.steps,
      },
    ],
    composition: [],
    expectedOutput: specification.expectedOutput,
  };
}

/**
 * Compiles a validated Phase 1 subplan specification into an n8n workflow.
 * Produces byte-identical output to compileNodewiseSpecification on the equivalent flat spec.
 */
function compileSubplanSpecification(specification) {
  const validatedSubplan = validateSubplanSpecification(specification);
  const block = validatedSubplan.blocks[0];

  const flatEquivalent = {
    schemaVersion: '1.0',
    kind: 'nodewise_step_specification',
    goal: validatedSubplan.goal,
    requiredUserSetup: [],
    expectedOutput: validatedSubplan.expectedOutput,
    steps: block.steps,
  };

  return compileNodewiseSpecification(flatEquivalent);
}

module.exports = {
  validateSubplanSpecification,
  compileSubplanSpecification,
};
