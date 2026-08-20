'use strict';

// A real-candidate skill trial. The tool receives repair issues only from the
// same authoritative Python validator used by Create. It can remove only a
// parameter the validator says is invalid; it cannot redesign a workflow.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { loadCandidate } = require('./runSavedMechanicalRepairTrial');
const { canonicalizeWorkflow } = require('../../agent/canonicalizeWorkflow');
const { getAuthoritativeRepairContext } = require('../../agent/getAuthoritativeRepairContext');
const { runRuntimeRepairSkillTrial } = require('../../agent/runRuntimeRepairSkillTrial');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function authoritativeSchemaIssues({ workflow, userRequest, inspect = getAuthoritativeRepairContext }) {
  return inspect({ workflow, userRequest })
    .filter((finding) => finding?.category === 'parameter_schema'
      && Number.isInteger(finding?.repairContext?.nodeIndex)
      && typeof finding.repairContext.parameterName === 'string')
    .map((finding) => ({
      kind: 'parameter_schema',
      nodeIndex: finding.repairContext.nodeIndex,
      nodeType: typeof finding.repairContext.nodeType === 'string' ? finding.repairContext.nodeType : null,
      parameterName: finding.repairContext.parameterName,
    }));
}

async function runSavedAuthoritativeSchemaRepairTrial({ inputPath, predictionsPath, outputPath, caseId, canonicalize = canonicalizeWorkflow, inspect = getAuthoritativeRepairContext, runTrial = runRuntimeRepairSkillTrial, options = {} } = {}) {
  if (!inputPath || !predictionsPath || !outputPath || caseId === undefined) throw new TypeError('inputPath, predictionsPath, outputPath, and caseId are required');
  const candidate = loadCandidate({ inputPath, predictionsPath, caseId });
  const workflow = canonicalize({ workflow: candidate.workflow, userRequest: candidate.description });
  const initialFindings = inspect({ workflow, userRequest: candidate.description });
  const issueProvider = (currentWorkflow) => authoritativeSchemaIssues({ workflow: currentWorkflow, userRequest: candidate.description, inspect });
  const trial = await runTrial({ ...options, outputPath, workflow, userRequest: candidate.description, issueProvider });
  // The skill repairs an in-memory working copy. Inspect that same object,
  // rather than the original saved candidate, before declaring an outcome.
  const repairedWorkflow = trial.finalWorkflow || workflow;
  const finalFindings = inspect({ workflow: repairedWorkflow, userRequest: candidate.description });
  const authoritativePass = finalFindings.length === 0;
  const outcome = trial.outcome === 'agent_unavailable'
    ? 'agent_unavailable'
    : (authoritativePass ? 'static_pass' : 'static_blocked');
  const report = {
    ...trial,
    outcome,
    kind: 'easy100_saved_authoritative_schema_repair_trial',
    caseId: String(caseId),
    authoritativeInitialFindingCategories: countCategories(initialFindings),
    authoritativeFinalFindingCategories: countCategories(finalFindings),
    predictionSetFingerprint: sha256(fs.readFileSync(predictionsPath, 'utf8')),
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

function countCategories(findings) {
  const counts = {};
  for (const finding of findings || []) {
    const category = typeof finding?.category === 'string' ? finding.category : 'unknown';
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

module.exports = { authoritativeSchemaIssues, countCategories, runSavedAuthoritativeSchemaRepairTrial };
