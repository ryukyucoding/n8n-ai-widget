'use strict';

// The public n8n Create endpoint accepts workflow content only. Keep this
// projection in one pure module so every Create caller has the same contract.
const CREATE_WORKFLOW_ROOT_KEYS = Object.freeze([
  'name',
  'nodes',
  'connections',
  'settings',
  'staticData',
  'pinData',
]);

function sanitizeCreateWorkflowPayload(workflow) {
  const payload = {};
  for (const key of CREATE_WORKFLOW_ROOT_KEYS) {
    if (workflow[key] !== undefined) payload[key] = workflow[key];
  }
  return payload;
}

module.exports = {
  CREATE_WORKFLOW_ROOT_KEYS,
  sanitizeCreateWorkflowPayload,
};
