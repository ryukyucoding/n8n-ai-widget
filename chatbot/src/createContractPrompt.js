'use strict';

const { acceptanceContractFingerprint } = require('./acceptanceContract');

const N8N_CODE_SAFETY_INSTRUCTION = [
  'n8n Code safety rules (apply to every candidate):',
  '1. $input.all(), $input.first(), and equivalent Code-node input items are n8n wrappers. Read payload fields through item.json.<field>, or explicitly map/destructure item.json into a payload object before reading business fields. Do not read business fields directly from a wrapper item.',
  '2. When Code reads a named upstream node with $(\'Upstream\').first(), .all(), .item(), or .itemMatching(), that producer must be guaranteed to finish (must-execute-before) on every path that can trigger Code. Sibling branches feeding the same any-input Code node are not synchronization. Prefer a serial topology for multiple upstream values; use fan-in only when the runtime explicitly proves an all-required-input barrier.',
].join('\n');

function buildN8nCodeSafetyInstruction() {
  return N8N_CODE_SAFETY_INSTRUCTION;
}

function contractPromptPayload(acceptanceContract) {
  if (!acceptanceContract || typeof acceptanceContract !== 'object') return null;
  return {
    contractRevision: acceptanceContract.contractRevision ?? null,
    contractFingerprint: acceptanceContractFingerprint(acceptanceContract),
    acceptanceContract,
  };
}

function buildAcceptanceContractInstruction(acceptanceContract) {
  const payload = contractPromptPayload(acceptanceContract);
  if (!payload) return null;
  return [
    'Use this immutable acceptance contract for this candidate.',
    'It is authoritative for the requested delivery shape and output requirements.',
    'Do not replace it with inferred aliases, stringify final output data, or change its delivery shape.',
    JSON.stringify(payload),
  ].join('\n');
}

function buildCreateCandidateMessages({ systemPrompt, userRequest, acceptanceContract, repairPrompt } = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userRequest },
  ];
  const contractInstruction = buildAcceptanceContractInstruction(acceptanceContract);
  if (contractInstruction) messages.push({ role: 'user', content: contractInstruction });
  messages.push({ role: 'user', content: buildN8nCodeSafetyInstruction() });
  if (repairPrompt) messages.push({ role: 'user', content: repairPrompt });
  return messages;
}

function buildSemanticReviewerInput({ userRequest, acceptanceContract, workflow, dataflowSummary } = {}) {
  return JSON.stringify({
    userRequest,
    contract: contractPromptPayload(acceptanceContract),
    codeSafetyInstruction: buildN8nCodeSafetyInstruction(),
    dataflowSummary,
    workflow,
  });
}

function createContractReady(acceptanceContract) {
  return Boolean(acceptanceContract && acceptanceContract.configurationStatus === 'complete'
    && acceptanceContract.outputSchema?.status !== 'clarification_required');
}

module.exports = {
  contractPromptPayload,
  buildAcceptanceContractInstruction,
  buildN8nCodeSafetyInstruction,
  buildCreateCandidateMessages,
  buildSemanticReviewerInput,
  createContractReady,
};
