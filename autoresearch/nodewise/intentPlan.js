'use strict';

const CAPABILITIES = new Set([
  'manual_trigger',
  'schedule_trigger',
  'http_request',
  'data_transform',
  'conditional_branch',
  'set_output',
  'external_action',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, field) {
  assert(typeof value === 'string' && value.trim(), `${field} must be a non-empty string`);
  return value.trim();
}

function safeFieldList(value, field) {
  assert(Array.isArray(value) && value.length <= 20, `${field} must be an array of at most 20 items`);
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

// This is a stable semantic contract. The compiler, not the planning agent,
// later maps these capabilities to the installed n8n node schema.
function validateIntentPlan(plan) {
  assert(plan && typeof plan === 'object' && !Array.isArray(plan), 'plan must be an object');
  assert(plan.schemaVersion === '1.0', 'schemaVersion must be 1.0');
  assert(plan.kind === 'nodewise_workflow_intent', 'kind must be nodewise_workflow_intent');
  const goal = nonEmptyString(plan.goal, 'goal');
  assert(Array.isArray(plan.steps) && plan.steps.length >= 1 && plan.steps.length <= 12, 'steps must contain 1 to 12 items');
  const seen = new Set();
  const steps = plan.steps.map((step, index) => {
    assert(step && typeof step === 'object' && !Array.isArray(step), `steps[${index}] must be an object`);
    const id = nonEmptyString(step.id, `steps[${index}].id`);
    assert(/^[a-z][a-z0-9-]{0,39}$/.test(id), `steps[${index}].id has an invalid format`);
    assert(!seen.has(id), `steps[${index}].id must be unique`);
    seen.add(id);
    const capability = nonEmptyString(step.capability, `steps[${index}].capability`);
    assert(CAPABILITIES.has(capability), `steps[${index}].capability is not supported`);
    const purpose = nonEmptyString(step.purpose, `steps[${index}].purpose`);
    const inputs = safeFieldList(step.inputs || [], `steps[${index}].inputs`);
    const outputs = safeFieldList(step.outputs || [], `steps[${index}].outputs`);
    const userSetup = safeFieldList(step.requiredUserSetup || [], `steps[${index}].requiredUserSetup`);
    for (const input of inputs) {
      const source = input.split('.', 1)[0];
      assert(seen.has(source), `steps[${index}].inputs must reference an earlier step`);
    }
    return { id, capability, purpose, inputs, outputs, requiredUserSetup: userSetup };
  });
  assert(plan.expectedOutput && typeof plan.expectedOutput === 'object' && !Array.isArray(plan.expectedOutput), 'expectedOutput must be an object');
  const deliveryShape = nonEmptyString(plan.expectedOutput.deliveryShape, 'expectedOutput.deliveryShape');
  assert(['one_object', 'items', 'side_effect'].includes(deliveryShape), 'expectedOutput.deliveryShape is not supported');
  const fields = safeFieldList(plan.expectedOutput.fields || [], 'expectedOutput.fields');
  const requiredUserSetup = safeFieldList(plan.requiredUserSetup || [], 'requiredUserSetup');
  return { schemaVersion: '1.0', kind: 'nodewise_workflow_intent', goal, steps, expectedOutput: { deliveryShape, fields }, requiredUserSetup };
}

function parseAndValidateIntentPlan(text) {
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error('reply must contain one JSON object and no Markdown fence'); }
  return validateIntentPlan(plan);
}

module.exports = { CAPABILITIES, parseAndValidateIntentPlan, validateIntentPlan };
