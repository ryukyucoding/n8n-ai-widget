'use strict';

const { createHash } = require('node:crypto');

const CONTRACT_VERSION = '1.0';
const DELIVERY_MODES = new Set(['candidate-only', 'n8n-draft', 'ready-to-run']);
const OUTPUT_DELIVERY_SHAPES = new Set(['single_object_item']);
const OUTPUT_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
const SECRET_KEY_PATTERN = /(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|oauth[_-]?secret|private[_-]?key|secret)/i;
const SECRET_VALUE_PATTERN = /^(?:sk-|pk_live_|ghp_|xox[baprs]-|bearer\s+)/i;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function valueAt(object, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  }
  return undefined;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizedText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function hasSecretLikeValue(value) {
  return typeof value === 'string' && SECRET_VALUE_PATTERN.test(value.trim());
}

function assertNoCredentialValues(value, path = 'planner') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialValues(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      // References/selectors/resource IDs are deliberately allowed, but raw
      // credential values are never admitted to an acceptance contract.
      const referenceKey = /(reference|selector|resource[_-]?id)$/i.test(key);
      if (!referenceKey && nested !== undefined && nested !== null && nested !== '') {
        throw new TypeError(`credential value is not allowed in acceptance contract: ${nestedPath}`);
      }
    }
    if (hasSecretLikeValue(nested)) {
      throw new TypeError(`secret-like credential value is not allowed in acceptance contract: ${nestedPath}`);
    }
    assertNoCredentialValues(nested, nestedPath);
  }
}

function requestHash(userRequest) {
  return createHash('sha256').update(normalizedText(userRequest), 'utf8').digest('hex');
}

function normalizeRequirement(item, index) {
  if (typeof item === 'string') {
    return { key: `requirement-${index + 1}`, requirement: normalizedText(item), required: true, value: null };
  }
  const source = item && typeof item === 'object' ? item : {};
  const value = valueAt(source, 'value', 'destination', 'resourceId', 'resource_id', 'selector', 'credentialReference', 'credential_reference');
  const credentialReference = valueAt(source, 'credentialReference', 'credential_reference', 'credentialSelector', 'credential_selector');
  const credentialSelector = valueAt(source, 'credentialSelector', 'credential_selector', 'selector');
  const resourceId = valueAt(source, 'resourceId', 'resource_id');
  return {
    key: normalizedText(source.key || source.id || source.name || source.kind) || `requirement-${index + 1}`,
    requirement: normalizedText(source.requirement || source.description || source.kind || source.name),
    kind: normalizedText(source.kind) || 'configuration',
    required: source.required !== false,
    value: typeof value === 'string' ? normalizedText(value) || null : value ?? null,
    credentialReference: typeof credentialReference === 'string' ? normalizedText(credentialReference) || null : credentialReference ?? null,
    credentialSelector: typeof credentialSelector === 'string' ? normalizedText(credentialSelector) || null : credentialSelector ?? null,
    resourceId: typeof resourceId === 'string' ? normalizedText(resourceId) || null : resourceId ?? null,
  };
}

function normalizedFieldPath(value) {
  const path = normalizedText(value);
  if (!path || path.split('.').some((segment) => !segment || /^(?:__proto__|prototype|constructor)$/i.test(segment))) return null;
  return path;
}

function canonicalFieldPath(path) {
  return path.split('.').map((segment) => segment.toLowerCase().replace(/[_-]/g, '')).join('.');
}

function normalizeOutputField(field) {
  const source = field && typeof field === 'object' && !Array.isArray(field) ? field : {};
  const path = normalizedFieldPath(valueAt(source, 'path', 'name', 'field'));
  const expectedType = normalizedText(valueAt(source, 'expectedType', 'expected_type', 'type'));
  return {
    path,
    required: source.required === true,
    expectedType: OUTPUT_FIELD_TYPES.has(expectedType) ? expectedType : null,
  };
}

function normalizeOutputSchema(planner, rawOutputContract) {
  const source = rawOutputContract && typeof rawOutputContract === 'object' && !Array.isArray(rawOutputContract)
    ? rawOutputContract
    : {};
  const required = planner.outputContractRequired === true || planner.output_contract_required === true || source.required === true;
  const deliveryShape = normalizedText(valueAt(source, 'deliveryShape', 'delivery_shape')) || null;
  const rawItemCount = valueAt(source, 'itemCount', 'item_count');
  const itemCount = Number.isInteger(rawItemCount) && rawItemCount >= 0 ? rawItemCount : null;
  const rawFields = Array.isArray(source.fields) ? source.fields : [];
  const fields = rawFields.map(normalizeOutputField);
  const malformedField = fields.some((field) => !field.path || !field.required || !field.expectedType);
  const aliases = new Map();
  for (const field of fields) {
    if (!field.path) continue;
    const canonical = canonicalFieldPath(field.path);
    const existing = aliases.get(canonical);
    if (existing && existing !== field.path) {
      throw new TypeError('acceptance contract output fields must not mix aliases');
    }
    if (existing === field.path) throw new TypeError('acceptance contract output fields must not duplicate a path');
    aliases.set(canonical, field.path);
  }
  const complete = !required || (
    OUTPUT_DELIVERY_SHAPES.has(deliveryShape)
    && itemCount === 1
    && fields.length > 0
    && !malformedField
  );
  return {
    required,
    deliveryShape,
    itemCount,
    fields,
    status: complete ? (required ? 'complete' : 'not_required') : 'clarification_required',
  };
}

function derivedExecutionAssertions(outputSchema) {
  if (outputSchema.status !== 'complete' || !outputSchema.required) return [];
  return [
    { kind: 'item_count', equals: outputSchema.itemCount },
    ...outputSchema.fields.map((field) => ({ path: field.path, required: field.required, expectedType: field.expectedType })),
  ];
}

function isConfigured(requirement) {
  if (!requirement.required) return true;
  const value = requirement.value ?? requirement.credentialReference ?? requirement.credentialSelector ?? requirement.resourceId;
  return value !== null && value !== undefined && value !== '';
}

function normalizePlannerResult(plannerResult) {
  const planner = plannerResult && typeof plannerResult === 'object' ? plannerResult : {};
  assertNoCredentialValues(planner);
  const rawOutputContract = valueAt(planner, 'outputContract', 'output_contract');
  const outputSchema = normalizeOutputSchema(planner, rawOutputContract);
  const requiredConfiguration = asArray(valueAt(planner, 'requiredConfiguration', 'required_configuration'))
    .map(normalizeRequirement);
  return {
    goal: clone(valueAt(planner, 'goal')) ?? null,
    trigger: clone(valueAt(planner, 'trigger')) ?? null,
    requiredCapabilities: clone(asArray(valueAt(planner, 'requiredCapabilities', 'required_capabilities'))),
    dataSources: clone(asArray(valueAt(planner, 'dataSources', 'data_sources'))),
    outputAssertions: clone(Array.isArray(rawOutputContract) ? rawOutputContract : outputSchema.fields),
    outputSchema,
    dataflowAssertions: clone(asArray(valueAt(planner, 'dataflowAssertions', 'data_flow_requirements'))),
    // Execution assertions are only retained when a planner or trusted fixture
    // explicitly declares them. This normalizer never infers assertions from
    // field names or candidate workflow details.
    executionAssertions: clone(asArray(valueAt(planner, 'executionAssertions', 'execution_assertions'))),
    requiredConfiguration,
    allowedAssumptions: clone(asArray(valueAt(planner, 'allowedAssumptions', 'assumptions'))),
    requiredUserInputs: clone(asArray(valueAt(planner, 'requiredUserInputs', 'required_user_inputs'))),
    // Retained as an explicit planner artifact but never interpreted as a new
    // business requirement by this normalizer.
    generatorInstruction: valueAt(planner, 'generatorInstruction', 'generator_instruction') ?? null,
  };
}

function hasUserClarification(userClarification) {
  if (typeof userClarification === 'string') return Boolean(normalizedText(userClarification));
  if (Array.isArray(userClarification)) return userClarification.length > 0;
  return Boolean(userClarification && typeof userClarification === 'object' && Object.keys(userClarification).length);
}

function immutableExistingContract(existingContract, userClarification) {
  return existingContract && typeof existingContract === 'object' && !hasUserClarification(userClarification);
}

/**
 * Normalize planner output into an immutable-per-repair acceptance contract.
 * A caller must provide `userClarification` to create a later revision; a
 * candidate repair alone always reuses the supplied existing contract.
 */
function normalizeAcceptanceContract({ userRequest, plannerResult, deliveryMode = 'candidate-only', existingContract, userClarification } = {}) {
  if (immutableExistingContract(existingContract, userClarification)) return clone(existingContract);
  if (!DELIVERY_MODES.has(deliveryMode)) throw new TypeError('deliveryMode must be candidate-only, n8n-draft, or ready-to-run');
  if (!normalizedText(userRequest) && !(existingContract && existingContract.requestHash)) {
    throw new TypeError('userRequest must be a non-empty string');
  }

  const normalized = normalizePlannerResult(plannerResult);
  const unresolvedConfiguration = normalized.requiredConfiguration.filter((requirement) => !isConfigured(requirement));
  const requiredUserInputs = normalized.requiredUserInputs;
  const configurationStatus = unresolvedConfiguration.length || requiredUserInputs.length || normalized.outputSchema.status === 'clarification_required'
    ? 'clarification_required'
    : 'complete';
  // `ready-to-run` cannot silently turn unresolved requirements into a usable
  // workflow. Drafts may retain them, represented explicitly by the same
  // clarification-required status.
  const revision = existingContract && Number.isInteger(existingContract.contractRevision)
    ? existingContract.contractRevision + 1
    : 1;

  return {
    contractVersion: CONTRACT_VERSION,
    requestHash: existingContract?.requestHash || requestHash(userRequest),
    contractRevision: revision,
    deliveryMode,
    goal: normalized.goal,
    trigger: normalized.trigger,
    requiredCapabilities: normalized.requiredCapabilities,
    dataSources: normalized.dataSources,
    outputAssertions: normalized.outputAssertions,
    outputSchema: normalized.outputSchema,
    dataflowAssertions: normalized.dataflowAssertions,
    executionAssertions: [...derivedExecutionAssertions(normalized.outputSchema), ...normalized.executionAssertions],
    requiredConfiguration: normalized.requiredConfiguration,
    allowedAssumptions: normalized.allowedAssumptions,
    requiredUserInputs,
    generatorInstruction: normalized.generatorInstruction,
    configurationStatus,
  };
}

function acceptanceContractFingerprint(contract) {
  return createHash('sha256').update(stableJson(contract), 'utf8').digest('hex');
}

module.exports = { CONTRACT_VERSION, normalizeAcceptanceContract, acceptanceContractFingerprint, requestHash, stableJson };
