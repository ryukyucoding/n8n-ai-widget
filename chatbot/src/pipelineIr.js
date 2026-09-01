'use strict';

const SHAPE_PATTERN = /^(SingleItem|ItemList|Binary)<[A-Za-z][A-Za-z0-9_]*>$|^NoOutput$/;
const MERGE_POLICIES = new Set(['append', 'combine_by_index', 'first']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isShape(value) {
  return typeof value === 'string' && SHAPE_PATTERN.test(value);
}

function shapeKind(shape) {
  return shape === 'NoOutput' ? shape : shape.slice(0, shape.indexOf('<'));
}

function validateDependency(dependency, stepId, index, knownSteps) {
  assert(dependency && typeof dependency === 'object' && !Array.isArray(dependency), `${stepId}.dependsOn[${index}] must be an object`);
  assert(typeof dependency.step === 'string' && knownSteps.has(dependency.step), `${stepId}.dependsOn[${index}].step must reference a declared step`);
  assert(dependency.step !== stepId, `${stepId} cannot depend on itself`);
  if (dependency.sourcePort != null) assert(typeof dependency.sourcePort === 'string' && dependency.sourcePort.trim(), `${stepId}.dependsOn[${index}].sourcePort is invalid`);
  if (dependency.branch != null) assert(typeof dependency.branch === 'string' || typeof dependency.branch === 'boolean', `${stepId}.dependsOn[${index}].branch is invalid`);
  return {
    step: dependency.step,
    ...(dependency.sourcePort == null ? {} : { sourcePort: dependency.sourcePort }),
    ...(dependency.branch == null ? {} : { branch: dependency.branch }),
  };
}

function topologicalOrder(stepsById) {
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(id) {
    assert(!visiting.has(id), `IR contains a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of stepsById.get(id).dependsOn) visit(dependency.step);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  for (const id of stepsById.keys()) visit(id);
  return ordered;
}

// Validates planner-owned semantics before a compiler sees any n8n-specific JSON.
function validatePipelineIr(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'IR must be an object');
  assert(value.version === '1.0', 'IR version must be 1.0');
  assert(typeof value.goal === 'string' && value.goal.trim(), 'IR goal is required');
  assert(Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 50, 'IR must contain 1 to 50 steps');
  assert(value.expectedOutput && typeof value.expectedOutput === 'object', 'IR expectedOutput is required');
  assert(typeof value.expectedOutput.fromStep === 'string' && value.expectedOutput.fromStep, 'IR expectedOutput.fromStep is required');
  assert(isShape(value.expectedOutput.shape), 'IR expectedOutput.shape is invalid');
  assert(Array.isArray(value.expectedOutput.fields), 'IR expectedOutput.fields must be an array');

  const ids = new Set();
  for (const [index, step] of value.steps.entries()) {
    assert(step && typeof step === 'object' && !Array.isArray(step), `steps[${index}] must be an object`);
    assert(typeof step.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(step.id), `steps[${index}].id is invalid`);
    assert(!ids.has(step.id), `steps[${index}].id must be unique`);
    assert(typeof step.kind === 'string' && /^[a-z][a-z0-9_.-]+$/.test(step.kind), `steps[${index}].kind is invalid`);
    assert(isShape(step.outputShape), `steps[${index}].outputShape is invalid`);
    if (step.inputShape != null) assert(isShape(step.inputShape), `steps[${index}].inputShape is invalid`);
    ids.add(step.id);
  }
  assert(ids.has(value.expectedOutput.fromStep), 'IR expectedOutput.fromStep must reference a declared step');

  const stepsById = new Map();
  for (const step of value.steps) {
    const dependencies = step.dependsOn == null ? [] : step.dependsOn;
    assert(Array.isArray(dependencies), `${step.id}.dependsOn must be an array`);
    const normalizedDependencies = dependencies.map((dependency, index) => validateDependency(dependency, step.id, index, ids));
    assert(new Set(normalizedDependencies.map((dependency) => dependency.step)).size === normalizedDependencies.length, `${step.id}.dependsOn cannot repeat a step`);
    if (normalizedDependencies.length) assert(isShape(step.inputShape), `${step.id}.inputShape is required when dependsOn is present`);
    if (normalizedDependencies.length > 1) {
      assert(MERGE_POLICIES.has(step.mergePolicy), `${step.id}.mergePolicy is required for multiple inputs`);
    } else {
      assert(step.mergePolicy == null, `${step.id}.mergePolicy is only valid for multiple inputs`);
    }
    stepsById.set(step.id, { ...step, dependsOn: normalizedDependencies });
  }

  const consumers = new Map([...stepsById.keys()].map((id) => [id, 0]));
  for (const step of stepsById.values()) {
    for (const dependency of step.dependsOn) {
      const upstream = stepsById.get(dependency.step);
      assert(upstream.outputShape !== 'NoOutput', `${step.id} cannot consume NoOutput from ${dependency.step}`);
      if (step.dependsOn.length === 1) {
        assert(upstream.outputShape === step.inputShape, `${step.id}.inputShape must match ${dependency.step}.outputShape`);
      }
      consumers.set(dependency.step, consumers.get(dependency.step) + 1);
    }
  }

  topologicalOrder(stepsById);
  for (const step of stepsById.values()) {
    const isTrigger = step.kind.startsWith('trigger.');
    const isOutput = step.id === value.expectedOutput.fromStep;
    assert(isTrigger || isOutput || step.dependsOn.length > 0 || consumers.get(step.id) > 0, `${step.id} is isolated from the pipeline`);
  }

  const outputStep = stepsById.get(value.expectedOutput.fromStep);
  assert(outputStep.outputShape === value.expectedOutput.shape, 'IR expectedOutput.shape must match its source step');
  return {
    version: '1.0',
    goal: value.goal.trim(),
    steps: topologicalOrder(stepsById).map((id) => stepsById.get(id)),
    expectedOutput: { ...value.expectedOutput },
  };
}

module.exports = { MERGE_POLICIES, validatePipelineIr, shapeKind };
