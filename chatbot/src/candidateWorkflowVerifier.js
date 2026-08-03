'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
  buildWorkflowDataflowSummary,
  validateCodeDataflow,
  reconcileSemanticReview,
} = require('./workflowDataflow');

const VALID_OPERATIONS = new Set(['create', 'modify', 'insert', 'delete']);
const DEFAULT_REPAIR_SCRIPT = path.join(__dirname, '..', 'python', 'workflow_repair.py');

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function normalizeErrors(error) {
  return [errorMessage(error)].filter(Boolean);
}

function structuredFinding({ ruleId, severity, evidenceSource, category, location, message, repairable, normalized = false }) {
  return {
    ruleId,
    severity,
    evidenceSource,
    category,
    location: location && typeof location === 'object' ? location : { kind: 'workflow' },
    message,
    repairable: Boolean(repairable),
    normalized: Boolean(normalized),
  };
}

function normalizeExternalFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const severity = ['fatal', 'clarify', 'repair', 'warning'].includes(finding.severity) ? finding.severity : 'repair';
  const evidenceSource = ['runtime_schema', 'runtime_contract', 'deterministic_normalizer', 'semantic_review', 'n8n_api'].includes(finding.evidenceSource)
    ? finding.evidenceSource
    : 'runtime_schema';
  const category = ['json', 'node_schema', 'connection', 'dataflow', 'semantic', 'configuration'].includes(finding.category)
    ? finding.category
    : 'configuration';
  return structuredFinding({
    ruleId: typeof finding.ruleId === 'string' && finding.ruleId ? finding.ruleId : 'structural.external_finding',
    severity,
    evidenceSource,
    category,
    location: finding.location,
    message: typeof finding.message === 'string' ? finding.message : 'Structural validator reported a finding.',
    repairable: finding.repairable,
    normalized: finding.normalized,
  });
}

function connectionPortNormalizationFindings(repairs) {
  const portRepairs = repairs && Array.isArray(repairs.connectionPorts) ? repairs.connectionPorts : [];
  return portRepairs.map((repair) => {
    const isSource = repair?.kind === 'connection_source_port_normalized';
    const fromIndex = isSource ? repair?.fromOutputIndex : repair?.fromIndex;
    const toIndex = isSource ? repair?.toOutputIndex : repair?.toIndex;
    const direction = isSource ? 'source_output' : 'target_input';
    return structuredFinding({
      ruleId: `connection.port.${direction}.normalized`,
      severity: 'warning',
      evidenceSource: 'deterministic_normalizer',
      category: 'connection',
      // Names are display context only. This module does not derive or expose
      // a candidate fingerprint; future cycle detection must combine caller
      // supplied behavior and finding fingerprints instead.
      location: {
        kind: 'connection_port',
        direction,
        sourceNodeName: repair?.sourceNode || null,
        targetNodeName: repair?.targetNode || null,
        connectionType: repair?.connectionType || null,
        fromIndex: Number.isInteger(fromIndex) ? fromIndex : null,
        toIndex: Number.isInteger(toIndex) ? toIndex : null,
      },
      message: repair?.reason || 'A connection port was deterministically normalized.',
      repairable: false,
      normalized: true,
    });
  });
}

function dataflowFindings(summary) {
  const findings = [];
  for (const reference of summary.codeNodeReferences || []) {
    const location = {
      kind: 'code_reference',
      codeNodeName: reference.codeNode || null,
      referencedNodeName: reference.referencedNode || null,
      accessor: reference.accessor || null,
    };
    if (!reference.exists) {
      findings.push(structuredFinding({
        ruleId: 'dataflow.code_reference.missing_node', severity: 'repair', evidenceSource: 'runtime_contract', category: 'dataflow', location,
        message: `Code node '${reference.codeNode}' references missing node '${reference.referencedNode}'`, repairable: true,
      }));
    } else if (!reference.reachableBeforeCode) {
      findings.push(structuredFinding({
        ruleId: 'dataflow.code_reference.unreachable_before_execution', severity: 'repair', evidenceSource: 'runtime_contract', category: 'dataflow', location,
        message: `Code node '${reference.codeNode}' references '${reference.referencedNode}', which cannot reach it before execution`, repairable: true,
      }));
    } else if (!reference.mustExecuteBefore) {
      findings.push(structuredFinding({
        ruleId: 'dataflow.code_reference.must_execute_before', severity: 'repair', evidenceSource: 'runtime_contract', category: 'dataflow', location,
        message: `Code node '${reference.codeNode}' references '${reference.referencedNode}', which is reachable but not guaranteed to execute before it; an any-input branch may trigger the Code node first`, repairable: true,
      }));
    }
  }
  return findings;
}

function structuralErrorFindings(error) {
  const supplied = Array.isArray(error?.findings) ? error.findings.map(normalizeExternalFinding).filter(Boolean) : [];
  if (supplied.length) return supplied;
  // The existing Python adapter currently returns an opaque error string for
  // some structural failures. Keep its public error unchanged while retaining
  // a structured, non-string-parsed record for the failure boundary.
  return [structuredFinding({
    ruleId: 'structural.validation_failed', severity: 'repair', evidenceSource: 'runtime_schema', category: 'configuration',
    location: { kind: 'workflow_structure' }, message: errorMessage(error), repairable: true,
  })];
}

/**
 * Invoke the existing runtime-backed structural normalizer.  This is kept as
 * an adapter so any producer of a complete candidate workflow can use the
 * same verification contract without importing Create-specific code.
 */
function validateWorkflowStructure(input, options = {}) {
  const python = options.python || process.env.PYTHON_BIN || 'python3';
  const repairScript = options.repairScript || DEFAULT_REPAIR_SCRIPT;
  const candidate = typeof input.candidateWorkflow === 'string'
    ? input.candidateWorkflow
    : JSON.stringify(input.candidateWorkflow);
  const repairRes = spawnSync(python, [repairScript], {
    input: JSON.stringify({
      raw_output: candidate,
      n8n_url: options.n8nBaseUrl,
      api_key: options.n8nApiKey,
      user_request: input.userRequest,
    }),
    encoding: 'utf-8',
    env: { ...process.env, PYTHONUTF8: '1' },
    maxBuffer: 48 * 1024 * 1024,
  });

  if (repairRes.error) throw repairRes.error;
  const output = (repairRes.stdout || '').trim();
  let repairOut;
  try {
    repairOut = JSON.parse(output);
  } catch (_) {
    throw new Error((repairRes.stderr || output || `workflow_repair exited ${repairRes.status}`).trim());
  }
  if (!repairOut.ok) {
    const error = new Error(repairOut.error || 'Workflow structural validation failed');
    // Reserved additive bridge for the structural validator. Its existing
    // `ok`/`error` contract is unchanged; callers that can produce findings at
    // their validation site can attach them without string parsing here.
    if (Array.isArray(repairOut.findings)) error.findings = repairOut.findings;
    throw error;
  }
  if (repairRes.status !== 0) throw new Error(`workflow_repair exited ${repairRes.status}`);
  return {
    workflow: repairOut.workflow,
    warnings: Array.isArray(repairOut.warnings) ? repairOut.warnings : [],
    repairs: repairOut.repairs && typeof repairOut.repairs === 'object' ? repairOut.repairs : {},
    findings: Array.isArray(repairOut.findings) ? repairOut.findings : [],
  };
}

function requiredClarifications(acceptanceContract) {
  const questions = acceptanceContract && acceptanceContract.requiredUserInputs;
  if (!Array.isArray(questions)) return [];
  return questions
    .map((item) => (typeof item === 'string' ? item : item && item.question))
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
}

/**
 * Verify a complete candidate workflow from any producer (Create, Modify,
 * Insert, or Delete).  ``semanticReview`` is optional and supplied by the
 * caller because model selection belongs to the producing flow, not this
 * shared verifier.
 */
async function verifyCandidateWorkflow(input, options = {}) {
  const operation = input && input.operation;
  const base = {
    workflow: undefined,
    errors: [],
    warnings: [],
    findings: [],
    verification: {
      operation,
      structural: { status: 'not_run' },
      dataflow: { status: 'not_run', errors: [] },
      semantic: { status: 'not_run' },
    },
  };

  if (!input || !VALID_OPERATIONS.has(operation)) {
    return {
      ...base,
      status: 'clarify',
      errors: ['operation must be one of create, modify, insert, or delete'],
      findings: [structuredFinding({
        ruleId: 'input.operation.invalid', severity: 'clarify', evidenceSource: 'runtime_contract', category: 'configuration',
        location: { kind: 'request_field', field: 'operation' }, message: 'operation must be one of create, modify, insert, or delete', repairable: false,
      })],
    };
  }
  if (typeof input.userRequest !== 'string' || !input.userRequest.trim()) {
    return {
      ...base, status: 'clarify', errors: ['userRequest must be a non-empty string'],
      findings: [structuredFinding({
        ruleId: 'input.user_request.required', severity: 'clarify', evidenceSource: 'runtime_contract', category: 'configuration',
        location: { kind: 'request_field', field: 'userRequest' }, message: 'userRequest must be a non-empty string', repairable: false,
      })],
    };
  }
  if (input.candidateWorkflow === undefined || input.candidateWorkflow === null) {
    return {
      ...base, status: 'repair', errors: ['candidateWorkflow is required'],
      findings: [structuredFinding({
        ruleId: 'input.candidate_workflow.required', severity: 'repair', evidenceSource: 'runtime_contract', category: 'json',
        location: { kind: 'request_field', field: 'candidateWorkflow' }, message: 'candidateWorkflow is required', repairable: true,
      })],
    };
  }

  const questions = requiredClarifications(input.acceptanceContract);
  if (questions.length) {
    return {
      ...base,
      status: 'clarify',
      errors: questions.map((question) => `required user input: ${question}`),
      findings: questions.map((question, index) => structuredFinding({
        ruleId: 'acceptance_contract.required_user_input', severity: 'clarify', evidenceSource: 'runtime_contract', category: 'configuration',
        location: { kind: 'acceptance_contract_input', index }, message: `required user input: ${question}`, repairable: false,
      })),
    };
  }

  let workflow;
  try {
    const structuralValidator = options.structuralValidator || validateWorkflowStructure;
    const structuralResult = await structuralValidator(input, options);
    const structuralMetadata = structuralResult && typeof structuralResult === 'object'
      && Object.prototype.hasOwnProperty.call(structuralResult, 'workflow');
    workflow = structuralMetadata ? structuralResult.workflow : structuralResult;
    const structuralWarnings = structuralMetadata && Array.isArray(structuralResult.warnings) ? structuralResult.warnings : [];
    const structuralRepairs = structuralMetadata && structuralResult.repairs && typeof structuralResult.repairs === 'object' ? structuralResult.repairs : {};
    const structuralFindings = structuralMetadata && Array.isArray(structuralResult.findings)
      ? structuralResult.findings.map(normalizeExternalFinding).filter(Boolean)
      : [];
    base.workflow = workflow;
    base.warnings.push(...structuralWarnings);
    base.findings.push(...structuralFindings, ...connectionPortNormalizationFindings(structuralRepairs));
    base.verification.structural = { status: structuralWarnings.length ? 'warning' : 'pass', warnings: structuralWarnings, repairs: structuralRepairs };
  } catch (error) {
    base.verification.structural = { status: 'repair', errors: normalizeErrors(error) };
    base.findings.push(...structuralErrorFindings(error));
    return { ...base, status: 'repair', errors: base.verification.structural.errors };
  }

  const dataflowSummary = buildWorkflowDataflowSummary(workflow,
    Object.prototype.hasOwnProperty.call(options, 'runtimeSchemas') ? { runtimeSchemas: options.runtimeSchemas } : undefined);
  const dataflowErrors = validateCodeDataflow(dataflowSummary);
  const structuredDataflowFindings = dataflowFindings(dataflowSummary);
  base.findings.push(...structuredDataflowFindings);
  base.verification.dataflow = {
    status: dataflowErrors.length ? 'repair' : 'pass',
    errors: dataflowErrors,
    summary: dataflowSummary,
  };
  if (dataflowErrors.length) {
    return { ...base, status: 'repair', errors: dataflowErrors };
  }

  if (typeof options.semanticReview === 'function') {
    try {
      const review = await options.semanticReview({
        operation,
        userRequest: input.userRequest,
        workflow,
        acceptanceContract: input.acceptanceContract || null,
        dataflowSummary,
      });
      const reconciled = reconcileSemanticReview(review, dataflowSummary);
      base.warnings.push(...reconciled.warnings);
      base.findings.push(...reconciled.issues.map((issue, index) => structuredFinding({
        ruleId: 'semantic.review.revise', severity: 'repair', evidenceSource: 'semantic_review', category: 'semantic',
        location: { kind: 'semantic_issue', index, evidenceKind: issue?.evidence?.kind || null },
        message: issue?.message || 'Semantic review requested a revision.', repairable: true,
      })));
      base.findings.push(...reconciled.warnings.map((warning, index) => structuredFinding({
        ruleId: 'semantic.review.warning', severity: 'warning', evidenceSource: 'semantic_review', category: 'semantic',
        location: { kind: 'semantic_warning', index }, message: warning, repairable: false,
      })));
      base.verification.semantic = {
        status: reconciled.verdict === 'revise' ? 'repair' : 'pass',
        issues: reconciled.issues,
        warnings: reconciled.warnings,
      };
      if (reconciled.verdict === 'revise') {
        const errors = reconciled.issues.map((issue) => issue.message);
        return {
          ...base,
          status: 'repair',
          errors,
          verification: {
            ...base.verification,
            semantic: { ...base.verification.semantic, repairInstruction: reconciled.repairInstruction },
          },
        };
      }
    } catch (error) {
      // A reviewer is advisory. Its unavailability must not negate verified
      // runtime/schema/dataflow facts or turn an otherwise safe workflow into
      // a model-dependent failure.
      const warning = `Semantic review unavailable: ${errorMessage(error)}`;
      base.warnings.push(warning);
      base.findings.push(structuredFinding({
        ruleId: 'semantic.review.unavailable', severity: 'warning', evidenceSource: 'semantic_review', category: 'semantic',
        location: { kind: 'semantic_review' }, message: warning, repairable: false,
      }));
      base.verification.semantic = { status: 'warning', warnings: [warning] };
    }
  } else {
    base.verification.semantic = { status: 'skipped' };
  }

  return { ...base, status: base.warnings.length ? 'warning' : 'pass' };
}

module.exports = {
  VALID_OPERATIONS,
  validateWorkflowStructure,
  verifyCandidateWorkflow,
};
