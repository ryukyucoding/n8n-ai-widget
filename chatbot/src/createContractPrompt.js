'use strict';

const { acceptanceContractFingerprint } = require('./acceptanceContract');

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
  if (repairPrompt) messages.push({ role: 'user', content: repairPrompt });
  return messages;
}

function buildSemanticReviewerInput({ userRequest, acceptanceContract, workflow, dataflowSummary } = {}) {
  return JSON.stringify({
    userRequest,
    contract: contractPromptPayload(acceptanceContract),
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
  buildCreateCandidateMessages,
  buildSemanticReviewerInput,
  createContractReady,
};
